/*
 * cc-lhc exact process identity — Node-API addon (NAPI_VERSION 8, C only).
 *
 * One translation unit; the platform implementation is selected at compile
 * time. Every platform returns the same normalized shape:
 *
 *   pid       — the queried pid, echoed back
 *   bootId    — boot-session discriminator (see per-platform notes below)
 *   starttime — kernel-held process birth time, decimal digits only
 *
 * Per-platform sources of truth:
 *   linux : bootId  = /proc/sys/kernel/random/boot_id (per-boot UUID)
 *           starttime = field 22 of /proc/<pid>/stat (clock ticks since boot)
 *   darwin: bootId  = sysctl kern.bootsessionuuid (per-boot UUID)
 *           starttime = kinfo_proc kp_proc.p_starttime as microseconds since
 *           the Unix epoch (exact kernel timeval, not seconds-resolution ps)
 *   win32 : bootId  = constant "win32-filetime-1601" — the creation FILETIME
 *           is absolute (100ns units since 1601, kernel-held, immutable for
 *           the process object), so pid + starttime is already exact across
 *           boots and no separate boot identity is required
 *           starttime = GetProcessTimes creation FILETIME as a decimal
 *           unsigned 64-bit count of 100ns intervals
 *
 * Result object: { ok: true, pid, bootId, starttime }
 *            or { ok: false, code, message } with code one of
 *            "invalid_pid" | "not_found" | "access_denied" | "native_error".
 * Callers must fail closed on anything but ok === true.
 *
 * readFileIdentity(path) — exact identity of the file at a path, from the
 * opened file object, for adopting a surviving background command's output
 * across a Claude child replacement (LIM-145):
 *
 *   volumeId — the volume the file lives on (decimal digits)
 *   fileId   — the file object on that volume, tagged by its source:
 *              linux/darwin "ino:<st_ino>" (st_dev is the volumeId)
 *              win32        "id128:<32 hex>" from GetFileInformationByHandleEx
 *                           FileIdInfo (NTFS/ReFS 128-bit file id, exact), or
 *                           "index64:<n>" from GetFileInformationByHandle when
 *                           the volume has no 128-bit id (FAT, some shares)
 *
 * Result object: { ok: true, path, volumeId, fileId }
 *            or { ok: false, code, message } with code one of
 *            "invalid_path" | "not_found" | "access_denied" | "not_a_file" |
 *            "native_error". Equality is exact string equality of both parts.
 *
 * Supervised-child control (contract 3, LIM-149): the wrapper replaces its
 * Claude child during Smart Compact and keeps the old child around, paused,
 * as the supervisor of its own still-running background tasks, so their real
 * exit outcome survives the replacement. Every target is a child the wrapper
 * spawned; the TypeScript layer gates each call on exact identity first.
 *
 *   pauseProcess(pid) / resumeProcess(pid)
 *     linux/darwin: SIGSTOP / SIGCONT; win32: ntdll process suspend/resume.
 *     Result { ok: true, pid } or a failure with "invalid_pid" | "not_found" |
 *     "access_denied" | "native_error".
 *
 *   readChildExit(pid, starttime) — the exit record of a task whose (paused)
 *     supervisor has not collected it yet. starttime must equal the value
 *     readProcessIdentity reported for that pid, else "identity_changed".
 *       linux : /proc/<pid>/stat state 'Z' + exit_code (field 52)
 *       darwin: sysctl KERN_PROC_PID SZOMB + p_xstat
 *       win32 : the process object retained by the parent's open handle;
 *               GetExitCodeProcess after the object is signaled
 *     Result { ok: true, pid, state: "running" }
 *         or { ok: true, pid, state: "exited", code }
 *         or { ok: true, pid, state: "signaled", signal } (POSIX only)
 *         or a failure with "invalid_pid" | "not_found" | "identity_changed" |
 *            "access_denied" | "native_error".
 *
 *   findChildHoldingFile(parentPid, path) — which direct child of parentPid
 *     holds the file at path open (the task writing its output file).
 *       linux : /proc children + stat through /proc/<pid>/fd/<n> (dev+ino)
 *       darwin: proc_listchildpids + PROC_PIDFDVNODEINFO (dev+ino)
 *       win32 : Toolhelp children ∩ Restart Manager holders of the path
 *     Result { ok: true, parentPid, path, pid, matches } where pid is the
 *     single matching child or null when zero or several match, or a failure
 *     with "invalid_pid" | "invalid_path" | "not_found" | "access_denied" |
 *     "native_error".
 */

#include <node_api.h>

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef enum {
  ID_OK = 0,
  ID_NOT_FOUND = 1,
  ID_ACCESS_DENIED = 2,
  ID_NATIVE_ERROR = 3
} id_status;

typedef struct {
  char boot_id[128];
  char starttime[32];
  char message[256];
} id_result;

typedef enum {
  FID_OK = 0,
  FID_NOT_FOUND = 1,
  FID_ACCESS_DENIED = 2,
  FID_NOT_A_FILE = 3,
  FID_NATIVE_ERROR = 4
} fid_status;

typedef struct {
  char volume_id[64];
  char file_id[80];
  char message[256];
} file_id_result;

/* Supervised-child control (identity contract 3). All targets are children
 * the calling wrapper spawned itself; every call is pid + exact-identity
 * gated by the TypeScript layer before it reaches here. */
typedef enum {
  PC_OK = 0,
  PC_NOT_FOUND = 1,
  PC_ACCESS_DENIED = 2,
  PC_NATIVE_ERROR = 3,
  PC_IDENTITY_CHANGED = 4
} pc_status;

typedef enum { CHILD_RUNNING = 0, CHILD_EXITED = 1, CHILD_SIGNALED = 2 } child_state;

typedef struct {
  child_state state;
  long long code;   /* exit code when CHILD_EXITED */
  long long signal; /* terminating signal when CHILD_SIGNALED */
  char message[256];
} exit_result;

typedef struct {
  long long pid; /* the single matching child, or -1 */
  int matches;   /* how many direct children hold the file */
  char message[256];
} holder_result;

#if defined(__linux__)

#include <errno.h>

#define IDENTITY_PLATFORM "linux"

static id_status read_identity(int64_t pid, id_result *out) {
  FILE *bf = fopen("/proc/sys/kernel/random/boot_id", "r");
  if (bf == NULL) {
    snprintf(out->message, sizeof(out->message), "cannot open boot_id (errno %d)", errno);
    return ID_NATIVE_ERROR;
  }
  char boot_raw[128];
  const char *got = fgets(boot_raw, (int)sizeof(boot_raw), bf);
  fclose(bf);
  if (got == NULL) {
    snprintf(out->message, sizeof(out->message), "cannot read boot_id");
    return ID_NATIVE_ERROR;
  }
  size_t blen = strlen(boot_raw);
  while (blen > 0 &&
         (boot_raw[blen - 1] == '\n' || boot_raw[blen - 1] == '\r' || boot_raw[blen - 1] == ' ')) {
    boot_raw[--blen] = '\0';
  }
  if (blen < 8) {
    snprintf(out->message, sizeof(out->message), "boot_id too short");
    return ID_NATIVE_ERROR;
  }
  snprintf(out->boot_id, sizeof(out->boot_id), "%s", boot_raw);

  char path[64];
  snprintf(path, sizeof(path), "/proc/%lld/stat", (long long)pid);
  FILE *sf = fopen(path, "r");
  if (sf == NULL) {
    if (errno == ENOENT || errno == ESRCH) {
      snprintf(out->message, sizeof(out->message), "no such process");
      return ID_NOT_FOUND;
    }
    if (errno == EACCES || errno == EPERM) {
      snprintf(out->message, sizeof(out->message), "access denied to %s", path);
      return ID_ACCESS_DENIED;
    }
    snprintf(out->message, sizeof(out->message), "cannot open %s (errno %d)", path, errno);
    return ID_NATIVE_ERROR;
  }
  char stat_line[2048];
  size_t n = fread(stat_line, 1, sizeof(stat_line) - 1, sf);
  fclose(sf);
  stat_line[n] = '\0';

  char pid_prefix[32];
  int plen = snprintf(pid_prefix, sizeof(pid_prefix), "%lld ", (long long)pid);
  if (plen <= 0 || strncmp(stat_line, pid_prefix, (size_t)plen) != 0) {
    snprintf(out->message, sizeof(out->message), "stat pid field mismatch");
    return ID_NATIVE_ERROR;
  }

  /* comm is "(...)" and may itself contain ')' or spaces; the last ')' ends
   * comm. starttime is 0-based field 19 of the post-comm fields (man 5 proc:
   * field 22 overall). This mirrors parseProcStatStarttime in cc-lhc. */
  const char *close_paren = strrchr(stat_line, ')');
  if (close_paren == NULL) {
    snprintf(out->message, sizeof(out->message), "stat comm not parseable");
    return ID_NATIVE_ERROR;
  }
  const char *p = close_paren + 1;
  int field = 0;
  while (*p != '\0') {
    while (*p == ' ') {
      p++;
    }
    if (*p == '\0' || *p == '\n') {
      break;
    }
    if (field == 19) {
      size_t i = 0;
      while (p[i] >= '0' && p[i] <= '9' && i + 1 < sizeof(out->starttime)) {
        out->starttime[i] = p[i];
        i++;
      }
      out->starttime[i] = '\0';
      if (i == 0 || (p[i] != ' ' && p[i] != '\0' && p[i] != '\n')) {
        snprintf(out->message, sizeof(out->message), "starttime field not numeric");
        return ID_NATIVE_ERROR;
      }
      return ID_OK;
    }
    while (*p != ' ' && *p != '\0' && *p != '\n') {
      p++;
    }
    field++;
  }
  snprintf(out->message, sizeof(out->message), "stat line too short");
  return ID_NATIVE_ERROR;
}

#include <dirent.h>
#include <limits.h>
#include <signal.h>
#include <sys/stat.h>

/* Copy 0-based post-comm field `index` of a /proc/<pid>/stat line (man 5 proc
 * numbering minus 3) into buf. Returns 1 when present. */
static int proc_stat_field(const char *stat_line, int index, char *buf, size_t blen) {
  const char *close_paren = strrchr(stat_line, ')');
  if (close_paren == NULL) {
    return 0;
  }
  const char *p = close_paren + 1;
  int field = 0;
  while (*p != '\0') {
    while (*p == ' ') {
      p++;
    }
    if (*p == '\0' || *p == '\n') {
      return 0;
    }
    if (field == index) {
      size_t i = 0;
      while (p[i] != ' ' && p[i] != '\0' && p[i] != '\n' && i + 1 < blen) {
        buf[i] = p[i];
        i++;
      }
      buf[i] = '\0';
      return i > 0;
    }
    while (*p != ' ' && *p != '\0' && *p != '\n') {
      p++;
    }
    field++;
  }
  return 0;
}

static pc_status read_proc_stat_line(int64_t pid, char *stat_line, size_t len, char *message, size_t mlen) {
  char path[64];
  snprintf(path, sizeof(path), "/proc/%lld/stat", (long long)pid);
  FILE *sf = fopen(path, "r");
  if (sf == NULL) {
    if (errno == ENOENT || errno == ESRCH) {
      snprintf(message, mlen, "no such process");
      return PC_NOT_FOUND;
    }
    if (errno == EACCES || errno == EPERM) {
      snprintf(message, mlen, "access denied to %s", path);
      return PC_ACCESS_DENIED;
    }
    snprintf(message, mlen, "cannot open %s (errno %d)", path, errno);
    return PC_NATIVE_ERROR;
  }
  size_t n = fread(stat_line, 1, len - 1, sf);
  fclose(sf);
  stat_line[n] = '\0';
  return PC_OK;
}

/* The unreaped exit record of a supervised task whose supervisor is paused:
 * state field 'Z' carries the wait status in field 52 (Linux ≥ 3.5). The
 * recorded starttime must still name the same incarnation. */
static pc_status read_child_exit(int64_t pid, const char *starttime, exit_result *out) {
  char stat_line[2048];
  pc_status s = read_proc_stat_line(pid, stat_line, sizeof(stat_line), out->message, sizeof(out->message));
  if (s != PC_OK) {
    return s;
  }
  char state[8];
  char start[32];
  char raw[32];
  if (!proc_stat_field(stat_line, 0, state, sizeof(state)) ||
      !proc_stat_field(stat_line, 19, start, sizeof(start))) {
    snprintf(out->message, sizeof(out->message), "stat line not parseable");
    return PC_NATIVE_ERROR;
  }
  if (strcmp(start, starttime) != 0) {
    snprintf(out->message, sizeof(out->message), "pid now names a different process");
    return PC_IDENTITY_CHANGED;
  }
  if (state[0] == 'X' || state[0] == 'x') {
    snprintf(out->message, sizeof(out->message), "process is dead");
    return PC_NOT_FOUND;
  }
  if (state[0] != 'Z') {
    out->state = CHILD_RUNNING;
    return PC_OK;
  }
  if (!proc_stat_field(stat_line, 49, raw, sizeof(raw))) {
    snprintf(out->message, sizeof(out->message), "kernel exposes no exit_code field (need Linux 3.5+)");
    return PC_NATIVE_ERROR;
  }
  long long status = strtoll(raw, NULL, 10);
  if (status < 0) {
    snprintf(out->message, sizeof(out->message), "exit_code field not parseable");
    return PC_NATIVE_ERROR;
  }
  if ((status & 0x7f) != 0) {
    out->state = CHILD_SIGNALED;
    out->signal = status & 0x7f;
    return PC_OK;
  }
  out->state = CHILD_EXITED;
  out->code = (status >> 8) & 0xff;
  return PC_OK;
}

/* Which direct child of `parent` holds `path` open: compare each child's open
 * file objects (stat through /proc/<pid>/fd/<n>) with the path's dev+ino. */
static pc_status find_child_holding_file(int64_t parent, const char *path, holder_result *out) {
  struct stat target;
  if (stat(path, &target) != 0) {
    if (errno == ENOENT || errno == ENOTDIR) {
      snprintf(out->message, sizeof(out->message), "no such file");
      return PC_NOT_FOUND;
    }
    if (errno == EACCES || errno == EPERM) {
      snprintf(out->message, sizeof(out->message), "access denied");
      return PC_ACCESS_DENIED;
    }
    snprintf(out->message, sizeof(out->message), "stat failed (errno %d)", errno);
    return PC_NATIVE_ERROR;
  }
  DIR *proc = opendir("/proc");
  if (proc == NULL) {
    snprintf(out->message, sizeof(out->message), "cannot open /proc (errno %d)", errno);
    return PC_NATIVE_ERROR;
  }
  out->pid = -1;
  out->matches = 0;
  struct dirent *ent;
  while ((ent = readdir(proc)) != NULL) {
    char *end = NULL;
    long long pid = strtoll(ent->d_name, &end, 10);
    if (end == ent->d_name || *end != '\0' || pid <= 0) {
      continue;
    }
    char stat_line[2048];
    char msg[256];
    if (read_proc_stat_line(pid, stat_line, sizeof(stat_line), msg, sizeof(msg)) != PC_OK) {
      continue;
    }
    char ppid[32];
    if (!proc_stat_field(stat_line, 1, ppid, sizeof(ppid)) || strtoll(ppid, NULL, 10) != parent) {
      continue;
    }
    char fd_dir[64];
    snprintf(fd_dir, sizeof(fd_dir), "/proc/%lld/fd", pid);
    DIR *fds = opendir(fd_dir);
    if (fds == NULL) {
      continue;
    }
    int holds = 0;
    struct dirent *fd;
    while (!holds && (fd = readdir(fds)) != NULL) {
      if (fd->d_name[0] < '0' || fd->d_name[0] > '9') {
        continue;
      }
      char fd_path[352];
      snprintf(fd_path, sizeof(fd_path), "%s/%s", fd_dir, fd->d_name);
      struct stat st;
      if (stat(fd_path, &st) == 0 && st.st_dev == target.st_dev && st.st_ino == target.st_ino) {
        holds = 1;
      }
    }
    closedir(fds);
    if (holds) {
      out->matches++;
      out->pid = pid;
    }
  }
  closedir(proc);
  if (out->matches != 1) {
    out->pid = -1;
  }
  return PC_OK;
}

#elif defined(__APPLE__)

#include <errno.h>
#include <limits.h>
#include <sys/proc.h>
#include <sys/sysctl.h>
#include <sys/time.h>
#include <sys/types.h>

#define IDENTITY_PLATFORM "darwin"

static id_status read_identity(int64_t pid, id_result *out) {
  if (pid > INT_MAX) {
    snprintf(out->message, sizeof(out->message), "pid exceeds platform range");
    return ID_NOT_FOUND;
  }

  char boot_uuid[64];
  size_t boot_len = sizeof(boot_uuid);
  if (sysctlbyname("kern.bootsessionuuid", boot_uuid, &boot_len, NULL, 0) != 0) {
    snprintf(out->message, sizeof(out->message), "kern.bootsessionuuid unavailable (errno %d)",
             errno);
    return ID_NATIVE_ERROR;
  }
  boot_uuid[sizeof(boot_uuid) - 1] = '\0';
  size_t blen = strlen(boot_uuid);
  while (blen > 0 &&
         (boot_uuid[blen - 1] == '\n' || boot_uuid[blen - 1] == '\r' || boot_uuid[blen - 1] == ' ')) {
    boot_uuid[--blen] = '\0';
  }
  if (blen < 8) {
    snprintf(out->message, sizeof(out->message), "kern.bootsessionuuid too short");
    return ID_NATIVE_ERROR;
  }
  snprintf(out->boot_id, sizeof(out->boot_id), "%s", boot_uuid);

  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, (int)pid};
  struct kinfo_proc kp;
  memset(&kp, 0, sizeof(kp));
  size_t len = sizeof(kp);
  if (sysctl(mib, 4, &kp, &len, NULL, 0) != 0) {
    if (errno == ESRCH || errno == ENOENT) {
      snprintf(out->message, sizeof(out->message), "no such process");
      return ID_NOT_FOUND;
    }
    if (errno == EPERM || errno == EACCES) {
      snprintf(out->message, sizeof(out->message), "access denied for pid %lld", (long long)pid);
      return ID_ACCESS_DENIED;
    }
    snprintf(out->message, sizeof(out->message), "sysctl KERN_PROC_PID failed (errno %d)", errno);
    return ID_NATIVE_ERROR;
  }
  /* sysctl reports success with zero length when the pid does not exist. */
  if (len == 0 || kp.kp_proc.p_pid != (pid_t)pid) {
    snprintf(out->message, sizeof(out->message), "no such process");
    return ID_NOT_FOUND;
  }
  unsigned long long sec = (unsigned long long)kp.kp_proc.p_starttime.tv_sec;
  unsigned long long usec = (unsigned long long)kp.kp_proc.p_starttime.tv_usec;
  if (sec == 0) {
    snprintf(out->message, sizeof(out->message), "kernel reported zero start time");
    return ID_NATIVE_ERROR;
  }
  snprintf(out->starttime, sizeof(out->starttime), "%llu", sec * 1000000ULL + usec);
  return ID_OK;
}

#include <libproc.h>
#include <signal.h>
#include <sys/proc_info.h>
#include <sys/stat.h>
#include <sys/wait.h>

static pc_status darwin_kinfo(int64_t pid, struct kinfo_proc *kp, char *message, size_t mlen) {
  if (pid > INT_MAX) {
    snprintf(message, mlen, "pid exceeds platform range");
    return PC_NOT_FOUND;
  }
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, (int)pid};
  memset(kp, 0, sizeof(*kp));
  size_t len = sizeof(*kp);
  if (sysctl(mib, 4, kp, &len, NULL, 0) != 0) {
    if (errno == ESRCH || errno == ENOENT) {
      snprintf(message, mlen, "no such process");
      return PC_NOT_FOUND;
    }
    if (errno == EPERM || errno == EACCES) {
      snprintf(message, mlen, "access denied for pid %lld", (long long)pid);
      return PC_ACCESS_DENIED;
    }
    snprintf(message, mlen, "sysctl KERN_PROC_PID failed (errno %d)", errno);
    return PC_NATIVE_ERROR;
  }
  if (len == 0 || kp->kp_proc.p_pid != (pid_t)pid) {
    snprintf(message, mlen, "no such process");
    return PC_NOT_FOUND;
  }
  return PC_OK;
}

/* The unreaped exit record of a supervised task whose supervisor is paused:
 * a SZOMB entry keeps its wait status in p_xstat until the parent collects
 * it. The recorded starttime must still name the same incarnation. */
static pc_status read_child_exit(int64_t pid, const char *starttime, exit_result *out) {
  struct kinfo_proc kp;
  pc_status s = darwin_kinfo(pid, &kp, out->message, sizeof(out->message));
  if (s != PC_OK) {
    return s;
  }
  char start[32];
  unsigned long long sec = (unsigned long long)kp.kp_proc.p_starttime.tv_sec;
  unsigned long long usec = (unsigned long long)kp.kp_proc.p_starttime.tv_usec;
  snprintf(start, sizeof(start), "%llu", sec * 1000000ULL + usec);
  if (strcmp(start, starttime) != 0) {
    snprintf(out->message, sizeof(out->message), "pid now names a different process");
    return PC_IDENTITY_CHANGED;
  }
  if (kp.kp_proc.p_stat != SZOMB) {
    out->state = CHILD_RUNNING;
    return PC_OK;
  }
  int status = (int)kp.kp_proc.p_xstat;
  if (WIFSIGNALED(status)) {
    out->state = CHILD_SIGNALED;
    out->signal = WTERMSIG(status);
    return PC_OK;
  }
  out->state = CHILD_EXITED;
  out->code = WEXITSTATUS(status);
  return PC_OK;
}

/* Which direct child of `parent` holds `path` open: compare each child's
 * vnode-backed descriptors (libproc) with the path's dev+ino. */
static pc_status find_child_holding_file(int64_t parent, const char *path, holder_result *out) {
  struct stat target;
  if (stat(path, &target) != 0) {
    if (errno == ENOENT || errno == ENOTDIR) {
      snprintf(out->message, sizeof(out->message), "no such file");
      return PC_NOT_FOUND;
    }
    if (errno == EACCES || errno == EPERM) {
      snprintf(out->message, sizeof(out->message), "access denied");
      return PC_ACCESS_DENIED;
    }
    snprintf(out->message, sizeof(out->message), "stat failed (errno %d)", errno);
    return PC_NATIVE_ERROR;
  }
  if (parent > INT_MAX) {
    snprintf(out->message, sizeof(out->message), "pid exceeds platform range");
    return PC_NOT_FOUND;
  }
  out->pid = -1;
  out->matches = 0;
  int bytes = proc_listchildpids((pid_t)parent, NULL, 0);
  if (bytes < 0) {
    snprintf(out->message, sizeof(out->message), "proc_listchildpids failed (errno %d)", errno);
    return PC_NATIVE_ERROR;
  }
  if (bytes == 0) {
    return PC_OK;
  }
  pid_t *pids = (pid_t *)malloc((size_t)bytes);
  if (pids == NULL) {
    snprintf(out->message, sizeof(out->message), "cannot allocate pid buffer");
    return PC_NATIVE_ERROR;
  }
  int got = proc_listchildpids((pid_t)parent, pids, bytes);
  int count = got > 0 ? got / (int)sizeof(pid_t) : 0;
  for (int i = 0; i < count; i++) {
    pid_t pid = pids[i];
    if (pid <= 0) {
      continue;
    }
    int fd_bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, NULL, 0);
    if (fd_bytes <= 0) {
      continue;
    }
    struct proc_fdinfo *fds = (struct proc_fdinfo *)malloc((size_t)fd_bytes);
    if (fds == NULL) {
      continue;
    }
    int fd_got = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds, fd_bytes);
    int fd_count = fd_got > 0 ? fd_got / PROC_PIDLISTFD_SIZE : 0;
    int holds = 0;
    for (int j = 0; j < fd_count && !holds; j++) {
      if (fds[j].proc_fdtype != PROX_FDTYPE_VNODE) {
        continue;
      }
      struct vnode_fdinfo vi;
      memset(&vi, 0, sizeof(vi));
      int r = proc_pidfdinfo(pid, fds[j].proc_fd, PROC_PIDFDVNODEINFO, &vi, PROC_PIDFDVNODEINFO_SIZE);
      if (r == PROC_PIDFDVNODEINFO_SIZE &&
          (unsigned long long)vi.pvi.vi_stat.vst_dev == (unsigned long long)target.st_dev &&
          (unsigned long long)vi.pvi.vi_stat.vst_ino == (unsigned long long)target.st_ino) {
        holds = 1;
      }
    }
    free(fds);
    if (holds) {
      out->matches++;
      out->pid = pid;
    }
  }
  free(pids);
  if (out->matches != 1) {
    out->pid = -1;
  }
  return PC_OK;
}

#elif defined(_WIN32)

#include <stdlib.h>
#include <windows.h>

#define IDENTITY_PLATFORM "win32"

/* FILE_ID_INFO as returned by GetFileInformationByHandleEx(FileIdInfo = 18):
 * declared here so the build does not depend on the SDK's _WIN32_WINNT gate. */
typedef struct {
  ULONGLONG VolumeSerialNumber;
  BYTE FileId[16];
} cc_file_id_info;

static fid_status read_file_identity(const char *path, file_id_result *out) {
  int wlen = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, NULL, 0);
  if (wlen <= 0) {
    snprintf(out->message, sizeof(out->message), "path is not valid UTF-8");
    return FID_NATIVE_ERROR;
  }
  WCHAR *wpath = (WCHAR *)malloc(sizeof(WCHAR) * (size_t)wlen);
  if (wpath == NULL) {
    snprintf(out->message, sizeof(out->message), "cannot allocate path buffer");
    return FID_NATIVE_ERROR;
  }
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, wpath, wlen);
  /* No access rights requested: identity comes from the file object itself,
   * and a writer holding the file open (the surviving command) is not
   * disturbed. BACKUP_SEMANTICS lets a directory open so it can be refused. */
  HANDLE h = CreateFileW(wpath, 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL,
                         OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, NULL);
  free(wpath);
  if (h == INVALID_HANDLE_VALUE) {
    DWORD err = GetLastError();
    if (err == ERROR_FILE_NOT_FOUND || err == ERROR_PATH_NOT_FOUND || err == ERROR_INVALID_NAME) {
      snprintf(out->message, sizeof(out->message), "no such file");
      return FID_NOT_FOUND;
    }
    if (err == ERROR_ACCESS_DENIED) {
      snprintf(out->message, sizeof(out->message), "access denied");
      return FID_ACCESS_DENIED;
    }
    snprintf(out->message, sizeof(out->message), "CreateFileW failed (error %lu)", (unsigned long)err);
    return FID_NATIVE_ERROR;
  }
  BY_HANDLE_FILE_INFORMATION bh;
  memset(&bh, 0, sizeof(bh));
  if (!GetFileInformationByHandle(h, &bh)) {
    DWORD err = GetLastError();
    CloseHandle(h);
    snprintf(out->message, sizeof(out->message), "GetFileInformationByHandle failed (error %lu)",
             (unsigned long)err);
    return FID_NATIVE_ERROR;
  }
  if (bh.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
    CloseHandle(h);
    snprintf(out->message, sizeof(out->message), "path is a directory");
    return FID_NOT_A_FILE;
  }
  cc_file_id_info info;
  memset(&info, 0, sizeof(info));
  BOOL have128 = GetFileInformationByHandleEx(h, (FILE_INFO_BY_HANDLE_CLASS)18, &info, (DWORD)sizeof(info));
  CloseHandle(h);
  if (have128) {
    char hex[33];
    for (int i = 0; i < 16; i++) {
      snprintf(hex + (i * 2), 3, "%02x", (unsigned)info.FileId[i]);
    }
    hex[32] = '\0';
    snprintf(out->volume_id, sizeof(out->volume_id), "%llu", (unsigned long long)info.VolumeSerialNumber);
    snprintf(out->file_id, sizeof(out->file_id), "id128:%s", hex);
    return FID_OK;
  }
  /* Volumes without a 128-bit file id: the 64-bit index, still from the
   * opened object, tagged so it never compares equal to an id128 value. */
  ULARGE_INTEGER idx;
  idx.LowPart = bh.nFileIndexLow;
  idx.HighPart = bh.nFileIndexHigh;
  snprintf(out->volume_id, sizeof(out->volume_id), "%lu", (unsigned long)bh.dwVolumeSerialNumber);
  snprintf(out->file_id, sizeof(out->file_id), "index64:%llu", (unsigned long long)idx.QuadPart);
  return FID_OK;
}

static const char *WIN32_BOOT_ID = "win32-filetime-1601";

static id_status read_identity(int64_t pid, id_result *out) {
  if (pid > (int64_t)MAXDWORD) {
    snprintf(out->message, sizeof(out->message), "pid exceeds platform range");
    return ID_NOT_FOUND;
  }

  /* SYNCHRONIZE is required for the WaitForSingleObject liveness probe and is
   * broadly grantable alongside PROCESS_QUERY_LIMITED_INFORMATION. */
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, (DWORD)pid);
  if (h == NULL) {
    DWORD err = GetLastError();
    if (err == ERROR_INVALID_PARAMETER) {
      snprintf(out->message, sizeof(out->message), "no such process");
      return ID_NOT_FOUND;
    }
    if (err == ERROR_ACCESS_DENIED) {
      snprintf(out->message, sizeof(out->message), "access denied for pid %lld", (long long)pid);
      return ID_ACCESS_DENIED;
    }
    snprintf(out->message, sizeof(out->message), "OpenProcess failed (error %lu)",
             (unsigned long)err);
    return ID_NATIVE_ERROR;
  }
  if (GetProcessId(h) != (DWORD)pid) {
    CloseHandle(h);
    snprintf(out->message, sizeof(out->message), "no such process");
    return ID_NOT_FOUND;
  }
  /* A pid whose process has exited but whose object is retained by open
   * handles is dead for ownership purposes: report not_found so stale-owner
   * reclamation can proceed. */
  DWORD wait = WaitForSingleObject(h, 0);
  if (wait == WAIT_OBJECT_0) {
    CloseHandle(h);
    snprintf(out->message, sizeof(out->message), "process has exited");
    return ID_NOT_FOUND;
  }
  if (wait != WAIT_TIMEOUT) {
    DWORD err = GetLastError();
    CloseHandle(h);
    snprintf(out->message, sizeof(out->message), "liveness probe failed (wait %lu, error %lu)",
             (unsigned long)wait, (unsigned long)err);
    return ID_NATIVE_ERROR;
  }
  FILETIME creation;
  FILETIME exit_time;
  FILETIME kernel_time;
  FILETIME user_time;
  if (!GetProcessTimes(h, &creation, &exit_time, &kernel_time, &user_time)) {
    DWORD err = GetLastError();
    CloseHandle(h);
    snprintf(out->message, sizeof(out->message), "GetProcessTimes failed (error %lu)",
             (unsigned long)err);
    return ID_NATIVE_ERROR;
  }
  CloseHandle(h);
  ULARGE_INTEGER t;
  t.LowPart = creation.dwLowDateTime;
  t.HighPart = creation.dwHighDateTime;
  if (t.QuadPart == 0) {
    snprintf(out->message, sizeof(out->message), "kernel reported zero creation time");
    return ID_NATIVE_ERROR;
  }
  snprintf(out->starttime, sizeof(out->starttime), "%llu", (unsigned long long)t.QuadPart);
  snprintf(out->boot_id, sizeof(out->boot_id), "%s", WIN32_BOOT_ID);
  return ID_OK;
}

#include <restartmgr.h>
#include <tlhelp32.h>

static pc_status win32_open_failure(DWORD err, const char *what, char *message, size_t mlen) {
  if (err == ERROR_INVALID_PARAMETER) {
    snprintf(message, mlen, "no such process");
    return PC_NOT_FOUND;
  }
  if (err == ERROR_ACCESS_DENIED) {
    snprintf(message, mlen, "access denied");
    return PC_ACCESS_DENIED;
  }
  snprintf(message, mlen, "%s failed (error %lu)", what, (unsigned long)err);
  return PC_NATIVE_ERROR;
}

/* Suspend/resume every thread of the wrapper's own supervised child at once.
 * ntdll's process-wide pair is the only whole-process primitive Windows
 * offers; it is resolved by name so the build needs no extra import library. */
typedef LONG(NTAPI *nt_process_fn)(HANDLE);

static pc_status pause_or_resume(int64_t pid, int resume, char *message, size_t mlen) {
  if (pid > (int64_t)MAXDWORD) {
    snprintf(message, mlen, "pid exceeds platform range");
    return PC_NOT_FOUND;
  }
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  if (ntdll == NULL) {
    snprintf(message, mlen, "ntdll.dll not mapped");
    return PC_NATIVE_ERROR;
  }
  FARPROC raw = GetProcAddress(ntdll, resume ? "NtResumeProcess" : "NtSuspendProcess");
  if (raw == NULL) {
    snprintf(message, mlen, "process suspend/resume entry point unavailable");
    return PC_NATIVE_ERROR;
  }
  nt_process_fn fn = (nt_process_fn)raw;
  HANDLE h = OpenProcess(PROCESS_SUSPEND_RESUME, FALSE, (DWORD)pid);
  if (h == NULL) {
    return win32_open_failure(GetLastError(), "OpenProcess", message, mlen);
  }
  LONG status = fn(h);
  CloseHandle(h);
  if (status < 0) {
    snprintf(message, mlen, "%s returned status 0x%08lx", resume ? "resume" : "suspend", (unsigned long)status);
    return PC_NATIVE_ERROR;
  }
  return PC_OK;
}

/* The exit record of a supervised task whose supervisor is paused: the
 * process object outlives the exit while the paused parent still holds its
 * handle, so the exit code stays readable. Creation time must still match. */
static pc_status read_child_exit(int64_t pid, const char *starttime, exit_result *out) {
  if (pid > (int64_t)MAXDWORD) {
    snprintf(out->message, sizeof(out->message), "pid exceeds platform range");
    return PC_NOT_FOUND;
  }
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, (DWORD)pid);
  if (h == NULL) {
    return win32_open_failure(GetLastError(), "OpenProcess", out->message, sizeof(out->message));
  }
  if (GetProcessId(h) != (DWORD)pid) {
    CloseHandle(h);
    snprintf(out->message, sizeof(out->message), "no such process");
    return PC_NOT_FOUND;
  }
  FILETIME creation;
  FILETIME exit_time;
  FILETIME kernel_time;
  FILETIME user_time;
  if (!GetProcessTimes(h, &creation, &exit_time, &kernel_time, &user_time)) {
    DWORD err = GetLastError();
    CloseHandle(h);
    snprintf(out->message, sizeof(out->message), "GetProcessTimes failed (error %lu)", (unsigned long)err);
    return PC_NATIVE_ERROR;
  }
  ULARGE_INTEGER t;
  t.LowPart = creation.dwLowDateTime;
  t.HighPart = creation.dwHighDateTime;
  char start[32];
  snprintf(start, sizeof(start), "%llu", (unsigned long long)t.QuadPart);
  if (strcmp(start, starttime) != 0) {
    CloseHandle(h);
    snprintf(out->message, sizeof(out->message), "pid now names a different process");
    return PC_IDENTITY_CHANGED;
  }
  DWORD wait = WaitForSingleObject(h, 0);
  if (wait == WAIT_TIMEOUT) {
    CloseHandle(h);
    out->state = CHILD_RUNNING;
    return PC_OK;
  }
  if (wait != WAIT_OBJECT_0) {
    DWORD err = GetLastError();
    CloseHandle(h);
    snprintf(out->message, sizeof(out->message), "liveness probe failed (wait %lu, error %lu)",
             (unsigned long)wait, (unsigned long)err);
    return PC_NATIVE_ERROR;
  }
  DWORD code = 0;
  if (!GetExitCodeProcess(h, &code)) {
    DWORD err = GetLastError();
    CloseHandle(h);
    snprintf(out->message, sizeof(out->message), "GetExitCodeProcess failed (error %lu)", (unsigned long)err);
    return PC_NATIVE_ERROR;
  }
  CloseHandle(h);
  out->state = CHILD_EXITED;
  out->code = (long long)code;
  return PC_OK;
}

/* Which direct child of `parent` holds `path` open: the Restart Manager
 * reports every process with the file open; intersect with the parent's
 * direct children from a process snapshot. */
static pc_status find_child_holding_file(int64_t parent, const char *path, holder_result *out) {
  out->pid = -1;
  out->matches = 0;
  if (parent > (int64_t)MAXDWORD) {
    snprintf(out->message, sizeof(out->message), "pid exceeds platform range");
    return PC_NOT_FOUND;
  }
  int wlen = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, NULL, 0);
  if (wlen <= 0) {
    snprintf(out->message, sizeof(out->message), "path is not valid UTF-8");
    return PC_NATIVE_ERROR;
  }
  WCHAR *wpath = (WCHAR *)malloc(sizeof(WCHAR) * (size_t)wlen);
  if (wpath == NULL) {
    snprintf(out->message, sizeof(out->message), "cannot allocate path buffer");
    return PC_NATIVE_ERROR;
  }
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, wpath, wlen);
  DWORD attrs = GetFileAttributesW(wpath);
  if (attrs == INVALID_FILE_ATTRIBUTES) {
    DWORD err = GetLastError();
    free(wpath);
    if (err == ERROR_FILE_NOT_FOUND || err == ERROR_PATH_NOT_FOUND || err == ERROR_INVALID_NAME) {
      snprintf(out->message, sizeof(out->message), "no such file");
      return PC_NOT_FOUND;
    }
    if (err == ERROR_ACCESS_DENIED) {
      snprintf(out->message, sizeof(out->message), "access denied");
      return PC_ACCESS_DENIED;
    }
    snprintf(out->message, sizeof(out->message), "GetFileAttributesW failed (error %lu)", (unsigned long)err);
    return PC_NATIVE_ERROR;
  }

  DWORD children[512];
  int nchildren = 0;
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) {
    DWORD err = GetLastError();
    free(wpath);
    snprintf(out->message, sizeof(out->message), "process snapshot failed (error %lu)", (unsigned long)err);
    return PC_NATIVE_ERROR;
  }
  PROCESSENTRY32W pe;
  memset(&pe, 0, sizeof(pe));
  pe.dwSize = sizeof(pe);
  if (Process32FirstW(snap, &pe)) {
    do {
      if (pe.th32ParentProcessID == (DWORD)parent && pe.th32ProcessID != (DWORD)parent &&
          nchildren < (int)(sizeof(children) / sizeof(children[0]))) {
        children[nchildren++] = pe.th32ProcessID;
      }
    } while (Process32NextW(snap, &pe));
  }
  CloseHandle(snap);
  if (nchildren == 0) {
    free(wpath);
    return PC_OK;
  }

  DWORD session = 0;
  WCHAR key[CCH_RM_SESSION_KEY + 1];
  memset(key, 0, sizeof(key));
  if (RmStartSession(&session, 0, key) != ERROR_SUCCESS) {
    free(wpath);
    snprintf(out->message, sizeof(out->message), "RmStartSession failed");
    return PC_NATIVE_ERROR;
  }
  LPCWSTR files[1];
  files[0] = wpath;
  pc_status result = PC_OK;
  if (RmRegisterResources(session, 1, files, 0, NULL, 0, NULL) != ERROR_SUCCESS) {
    snprintf(out->message, sizeof(out->message), "RmRegisterResources failed");
    result = PC_NATIVE_ERROR;
  } else {
    UINT needed = 0;
    UINT count = 0;
    DWORD reason = 0;
    DWORD rc = RmGetList(session, &needed, &count, NULL, &reason);
    if (rc == ERROR_MORE_DATA && needed > 0) {
      RM_PROCESS_INFO *infos = (RM_PROCESS_INFO *)malloc(sizeof(RM_PROCESS_INFO) * (size_t)needed);
      if (infos == NULL) {
        snprintf(out->message, sizeof(out->message), "cannot allocate holder list");
        result = PC_NATIVE_ERROR;
      } else {
        count = needed;
        rc = RmGetList(session, &needed, &count, infos, &reason);
        if (rc != ERROR_SUCCESS) {
          snprintf(out->message, sizeof(out->message), "RmGetList failed (error %lu)", (unsigned long)rc);
          result = PC_NATIVE_ERROR;
        } else {
          for (UINT i = 0; i < count; i++) {
            DWORD holder = infos[i].Process.dwProcessId;
            for (int c = 0; c < nchildren; c++) {
              if (children[c] == holder) {
                out->matches++;
                out->pid = (long long)holder;
                break;
              }
            }
          }
        }
        free(infos);
      }
    } else if (rc != ERROR_SUCCESS) {
      snprintf(out->message, sizeof(out->message), "RmGetList failed (error %lu)", (unsigned long)rc);
      result = PC_NATIVE_ERROR;
    }
  }
  RmEndSession(session);
  free(wpath);
  if (result == PC_OK && out->matches != 1) {
    out->pid = -1;
  }
  return result;
}

#else
#error "cc-lhc-native identity addon: unsupported platform"
#endif

#if defined(__linux__) || defined(__APPLE__)

#include <sys/stat.h>

/* Stop or continue every thread of the wrapper's own supervised child. */
static pc_status pause_or_resume(int64_t pid, int resume, char *message, size_t mlen) {
  if (pid > INT_MAX) {
    snprintf(message, mlen, "pid exceeds platform range");
    return PC_NOT_FOUND;
  }
  if (kill((pid_t)pid, resume ? SIGCONT : SIGSTOP) != 0) {
    if (errno == ESRCH) {
      snprintf(message, mlen, "no such process");
      return PC_NOT_FOUND;
    }
    if (errno == EPERM) {
      snprintf(message, mlen, "access denied for pid %lld", (long long)pid);
      return PC_ACCESS_DENIED;
    }
    snprintf(message, mlen, "kill failed (errno %d)", errno);
    return PC_NATIVE_ERROR;
  }
  return PC_OK;
}

/* POSIX: the device + inode of the file, the same facts stat(2) gives the
 * host; cc-lhc keeps using Node's stat dev+ino on these platforms and this
 * reader exists for parity tests and a uniform contract. */
static fid_status read_file_identity(const char *path, file_id_result *out) {
  struct stat st;
  if (stat(path, &st) != 0) {
    if (errno == ENOENT || errno == ENOTDIR) {
      snprintf(out->message, sizeof(out->message), "no such file");
      return FID_NOT_FOUND;
    }
    if (errno == EACCES || errno == EPERM) {
      snprintf(out->message, sizeof(out->message), "access denied");
      return FID_ACCESS_DENIED;
    }
    snprintf(out->message, sizeof(out->message), "stat failed (errno %d)", errno);
    return FID_NATIVE_ERROR;
  }
  if (!S_ISREG(st.st_mode)) {
    snprintf(out->message, sizeof(out->message), "path is not a regular file");
    return FID_NOT_A_FILE;
  }
  snprintf(out->volume_id, sizeof(out->volume_id), "%llu", (unsigned long long)st.st_dev);
  snprintf(out->file_id, sizeof(out->file_id), "ino:%llu", (unsigned long long)st.st_ino);
  return FID_OK;
}

#endif

/* ------------------------------------------------------------------------- */
/* Node-API glue                                                             */
/* ------------------------------------------------------------------------- */

#define IDENTITY_CONTRACT_VERSION 3
#define MAX_FILE_PATH_UTF8 32768

static napi_value make_string(napi_env env, const char *s) {
  napi_value v = NULL;
  if (napi_create_string_utf8(env, s, NAPI_AUTO_LENGTH, &v) != napi_ok) {
    return NULL;
  }
  return v;
}

static napi_value make_failure(napi_env env, const char *code, const char *message) {
  napi_value obj = NULL;
  napi_value ok_v = NULL;
  napi_value code_v = make_string(env, code);
  napi_value msg_v = make_string(env, message[0] == '\0' ? code : message);
  if (napi_create_object(env, &obj) != napi_ok || napi_get_boolean(env, false, &ok_v) != napi_ok ||
      code_v == NULL || msg_v == NULL) {
    return NULL;
  }
  if (napi_set_named_property(env, obj, "ok", ok_v) != napi_ok ||
      napi_set_named_property(env, obj, "code", code_v) != napi_ok ||
      napi_set_named_property(env, obj, "message", msg_v) != napi_ok) {
    return NULL;
  }
  return obj;
}

static napi_value ReadProcessIdentity(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) {
    napi_throw_type_error(env, NULL, "readProcessIdentity(pid) requires a pid argument");
    return NULL;
  }
  double dpid = 0;
  if (napi_get_value_double(env, argv[0], &dpid) != napi_ok) {
    napi_throw_type_error(env, NULL, "readProcessIdentity(pid): pid must be a number");
    return NULL;
  }
  if (!(dpid > 0) || dpid != (double)(int64_t)dpid || dpid > 9007199254740991.0) {
    return make_failure(env, "invalid_pid", "pid must be a positive integer");
  }
  int64_t pid = (int64_t)dpid;

  id_result r;
  memset(&r, 0, sizeof(r));
  id_status s = read_identity(pid, &r);
  if (s != ID_OK) {
    const char *code = s == ID_NOT_FOUND        ? "not_found"
                       : s == ID_ACCESS_DENIED ? "access_denied"
                                               : "native_error";
    return make_failure(env, code, r.message);
  }

  napi_value obj = NULL;
  napi_value ok_v = NULL;
  napi_value pid_v = NULL;
  napi_value boot_v = make_string(env, r.boot_id);
  napi_value start_v = make_string(env, r.starttime);
  if (napi_create_object(env, &obj) != napi_ok || napi_get_boolean(env, true, &ok_v) != napi_ok ||
      napi_create_int64(env, pid, &pid_v) != napi_ok || boot_v == NULL || start_v == NULL) {
    napi_throw_error(env, NULL, "cc-lhc identity: cannot allocate result");
    return NULL;
  }
  if (napi_set_named_property(env, obj, "ok", ok_v) != napi_ok ||
      napi_set_named_property(env, obj, "pid", pid_v) != napi_ok ||
      napi_set_named_property(env, obj, "bootId", boot_v) != napi_ok ||
      napi_set_named_property(env, obj, "starttime", start_v) != napi_ok) {
    napi_throw_error(env, NULL, "cc-lhc identity: cannot populate result");
    return NULL;
  }
  return obj;
}

static napi_value ReadFileIdentity(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) {
    napi_throw_type_error(env, NULL, "readFileIdentity(path) requires a path argument");
    return NULL;
  }
  napi_valuetype type;
  if (napi_typeof(env, argv[0], &type) != napi_ok || type != napi_string) {
    napi_throw_type_error(env, NULL, "readFileIdentity(path): path must be a string");
    return NULL;
  }
  size_t len = 0;
  if (napi_get_value_string_utf8(env, argv[0], NULL, 0, &len) != napi_ok) {
    napi_throw_error(env, NULL, "cc-lhc identity: cannot read path length");
    return NULL;
  }
  if (len == 0 || len >= MAX_FILE_PATH_UTF8) {
    return make_failure(env, "invalid_path", "path must be a non-empty string under 32768 bytes");
  }
  char *path = (char *)malloc(len + 1);
  if (path == NULL) {
    napi_throw_error(env, NULL, "cc-lhc identity: cannot allocate path");
    return NULL;
  }
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, argv[0], path, len + 1, &copied) != napi_ok) {
    free(path);
    napi_throw_error(env, NULL, "cc-lhc identity: cannot read path");
    return NULL;
  }
  if (strlen(path) != len) {
    free(path);
    return make_failure(env, "invalid_path", "path must not contain NUL");
  }

  file_id_result r;
  memset(&r, 0, sizeof(r));
  fid_status s = read_file_identity(path, &r);
  if (s != FID_OK) {
    free(path);
    const char *code = s == FID_NOT_FOUND       ? "not_found"
                       : s == FID_ACCESS_DENIED ? "access_denied"
                       : s == FID_NOT_A_FILE    ? "not_a_file"
                                                : "native_error";
    return make_failure(env, code, r.message);
  }

  napi_value obj = NULL;
  napi_value ok_v = NULL;
  napi_value path_v = make_string(env, path);
  napi_value vol_v = make_string(env, r.volume_id);
  napi_value file_v = make_string(env, r.file_id);
  free(path);
  if (napi_create_object(env, &obj) != napi_ok || napi_get_boolean(env, true, &ok_v) != napi_ok ||
      path_v == NULL || vol_v == NULL || file_v == NULL) {
    napi_throw_error(env, NULL, "cc-lhc identity: cannot allocate file result");
    return NULL;
  }
  if (napi_set_named_property(env, obj, "ok", ok_v) != napi_ok ||
      napi_set_named_property(env, obj, "path", path_v) != napi_ok ||
      napi_set_named_property(env, obj, "volumeId", vol_v) != napi_ok ||
      napi_set_named_property(env, obj, "fileId", file_v) != napi_ok) {
    napi_throw_error(env, NULL, "cc-lhc identity: cannot populate file result");
    return NULL;
  }
  return obj;
}

static const char *pc_code(pc_status s) {
  return s == PC_NOT_FOUND          ? "not_found"
         : s == PC_ACCESS_DENIED    ? "access_denied"
         : s == PC_IDENTITY_CHANGED ? "identity_changed"
                                    : "native_error";
}

/* Read argv[index] as a positive safe-integer pid; on a malformed value the
 * returned napi_value is the failure object to hand back (or NULL after a
 * thrown type error). */
static int read_pid_arg(napi_env env, napi_value arg, const char *fn, int64_t *pid, napi_value *failure) {
  double d = 0;
  if (napi_get_value_double(env, arg, &d) != napi_ok) {
    char msg[96];
    snprintf(msg, sizeof(msg), "%s: pid must be a number", fn);
    napi_throw_type_error(env, NULL, msg);
    *failure = NULL;
    return 0;
  }
  if (!(d > 0) || d != (double)(int64_t)d || d > 9007199254740991.0) {
    *failure = make_failure(env, "invalid_pid", "pid must be a positive integer");
    return 0;
  }
  *pid = (int64_t)d;
  return 1;
}

static napi_value ok_with_pid(napi_env env, int64_t pid, napi_value *obj_out) {
  napi_value obj = NULL;
  napi_value ok_v = NULL;
  napi_value pid_v = NULL;
  if (napi_create_object(env, &obj) != napi_ok || napi_get_boolean(env, true, &ok_v) != napi_ok ||
      napi_create_int64(env, pid, &pid_v) != napi_ok ||
      napi_set_named_property(env, obj, "ok", ok_v) != napi_ok ||
      napi_set_named_property(env, obj, "pid", pid_v) != napi_ok) {
    napi_throw_error(env, NULL, "cc-lhc identity: cannot allocate result");
    return NULL;
  }
  *obj_out = obj;
  return obj;
}

static napi_value PauseOrResume(napi_env env, napi_callback_info info, int resume) {
  const char *fn = resume ? "resumeProcess(pid)" : "pauseProcess(pid)";
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) {
    char msg[96];
    snprintf(msg, sizeof(msg), "%s requires a pid argument", fn);
    napi_throw_type_error(env, NULL, msg);
    return NULL;
  }
  int64_t pid = 0;
  napi_value failure = NULL;
  if (!read_pid_arg(env, argv[0], fn, &pid, &failure)) {
    return failure;
  }
  char message[256];
  message[0] = '\0';
  pc_status s = pause_or_resume(pid, resume, message, sizeof(message));
  if (s != PC_OK) {
    return make_failure(env, pc_code(s), message);
  }
  napi_value obj = NULL;
  return ok_with_pid(env, pid, &obj);
}

static napi_value PauseProcess(napi_env env, napi_callback_info info) { return PauseOrResume(env, info, 0); }

static napi_value ResumeProcess(napi_env env, napi_callback_info info) { return PauseOrResume(env, info, 1); }

static napi_value ReadChildExit(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 2) {
    napi_throw_type_error(env, NULL, "readChildExit(pid, starttime) requires pid and starttime");
    return NULL;
  }
  int64_t pid = 0;
  napi_value failure = NULL;
  if (!read_pid_arg(env, argv[0], "readChildExit(pid, starttime)", &pid, &failure)) {
    return failure;
  }
  napi_valuetype type;
  if (napi_typeof(env, argv[1], &type) != napi_ok || type != napi_string) {
    napi_throw_type_error(env, NULL, "readChildExit(pid, starttime): starttime must be a string");
    return NULL;
  }
  char starttime[32];
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, argv[1], starttime, sizeof(starttime), &copied) != napi_ok || copied == 0 ||
      copied >= sizeof(starttime) - 1) {
    return make_failure(env, "invalid_pid", "starttime must be 1-30 characters");
  }
  for (size_t i = 0; i < copied; i++) {
    if (starttime[i] < '0' || starttime[i] > '9') {
      return make_failure(env, "invalid_pid", "starttime must be digits only");
    }
  }
  exit_result r;
  memset(&r, 0, sizeof(r));
  pc_status s = read_child_exit(pid, starttime, &r);
  if (s != PC_OK) {
    return make_failure(env, pc_code(s), r.message);
  }
  napi_value obj = NULL;
  if (ok_with_pid(env, pid, &obj) == NULL) {
    return NULL;
  }
  const char *state = r.state == CHILD_RUNNING ? "running" : r.state == CHILD_EXITED ? "exited" : "signaled";
  napi_value state_v = make_string(env, state);
  napi_value num_v = NULL;
  if (state_v == NULL || napi_set_named_property(env, obj, "state", state_v) != napi_ok ||
      (r.state == CHILD_EXITED && (napi_create_int64(env, r.code, &num_v) != napi_ok ||
                                   napi_set_named_property(env, obj, "code", num_v) != napi_ok)) ||
      (r.state == CHILD_SIGNALED && (napi_create_int64(env, r.signal, &num_v) != napi_ok ||
                                     napi_set_named_property(env, obj, "signal", num_v) != napi_ok))) {
    napi_throw_error(env, NULL, "cc-lhc identity: cannot populate exit result");
    return NULL;
  }
  return obj;
}

static napi_value FindChildHoldingFile(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 2) {
    napi_throw_type_error(env, NULL, "findChildHoldingFile(parentPid, path) requires parentPid and path");
    return NULL;
  }
  int64_t parent = 0;
  napi_value failure = NULL;
  if (!read_pid_arg(env, argv[0], "findChildHoldingFile(parentPid, path)", &parent, &failure)) {
    return failure;
  }
  napi_valuetype type;
  if (napi_typeof(env, argv[1], &type) != napi_ok || type != napi_string) {
    napi_throw_type_error(env, NULL, "findChildHoldingFile(parentPid, path): path must be a string");
    return NULL;
  }
  size_t len = 0;
  if (napi_get_value_string_utf8(env, argv[1], NULL, 0, &len) != napi_ok) {
    napi_throw_error(env, NULL, "cc-lhc identity: cannot read path length");
    return NULL;
  }
  if (len == 0 || len >= MAX_FILE_PATH_UTF8) {
    return make_failure(env, "invalid_path", "path must be a non-empty string under 32768 bytes");
  }
  char *path = (char *)malloc(len + 1);
  if (path == NULL) {
    napi_throw_error(env, NULL, "cc-lhc identity: cannot allocate path");
    return NULL;
  }
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, argv[1], path, len + 1, &copied) != napi_ok) {
    free(path);
    napi_throw_error(env, NULL, "cc-lhc identity: cannot read path");
    return NULL;
  }
  if (strlen(path) != len) {
    free(path);
    return make_failure(env, "invalid_path", "path must not contain NUL");
  }
  holder_result r;
  memset(&r, 0, sizeof(r));
  r.pid = -1;
  pc_status s = find_child_holding_file(parent, path, &r);
  if (s != PC_OK) {
    free(path);
    return make_failure(env, pc_code(s), r.message);
  }
  napi_value obj = NULL;
  napi_value ok_v = NULL;
  napi_value parent_v = NULL;
  napi_value pid_v = NULL;
  napi_value matches_v = NULL;
  napi_value path_v = make_string(env, path);
  free(path);
  if (napi_create_object(env, &obj) != napi_ok || napi_get_boolean(env, true, &ok_v) != napi_ok ||
      napi_create_int64(env, parent, &parent_v) != napi_ok || path_v == NULL ||
      (r.pid < 0 ? napi_get_null(env, &pid_v) : napi_create_int64(env, r.pid, &pid_v)) != napi_ok ||
      napi_create_int32(env, r.matches, &matches_v) != napi_ok) {
    napi_throw_error(env, NULL, "cc-lhc identity: cannot allocate holder result");
    return NULL;
  }
  if (napi_set_named_property(env, obj, "ok", ok_v) != napi_ok ||
      napi_set_named_property(env, obj, "parentPid", parent_v) != napi_ok ||
      napi_set_named_property(env, obj, "path", path_v) != napi_ok ||
      napi_set_named_property(env, obj, "pid", pid_v) != napi_ok ||
      napi_set_named_property(env, obj, "matches", matches_v) != napi_ok) {
    napi_throw_error(env, NULL, "cc-lhc identity: cannot populate holder result");
    return NULL;
  }
  return obj;
}

static int register_fn(napi_env env, napi_value exports, const char *name, napi_callback cb) {
  napi_value fn = NULL;
  if (napi_create_function(env, name, NAPI_AUTO_LENGTH, cb, NULL, &fn) != napi_ok ||
      napi_set_named_property(env, exports, name, fn) != napi_ok) {
    char msg[96];
    snprintf(msg, sizeof(msg), "cc-lhc identity: cannot register %s", name);
    napi_throw_error(env, NULL, msg);
    return 0;
  }
  return 1;
}

NAPI_MODULE_INIT() {
  if (!register_fn(env, exports, "pauseProcess", PauseProcess) ||
      !register_fn(env, exports, "resumeProcess", ResumeProcess) ||
      !register_fn(env, exports, "readChildExit", ReadChildExit) ||
      !register_fn(env, exports, "findChildHoldingFile", FindChildHoldingFile)) {
    return NULL;
  }
  napi_value fn = NULL;
  if (napi_create_function(env, "readProcessIdentity", NAPI_AUTO_LENGTH, ReadProcessIdentity, NULL,
                           &fn) != napi_ok ||
      napi_set_named_property(env, exports, "readProcessIdentity", fn) != napi_ok) {
    napi_throw_error(env, NULL, "cc-lhc identity: cannot register readProcessIdentity");
    return NULL;
  }
  napi_value file_fn = NULL;
  if (napi_create_function(env, "readFileIdentity", NAPI_AUTO_LENGTH, ReadFileIdentity, NULL,
                           &file_fn) != napi_ok ||
      napi_set_named_property(env, exports, "readFileIdentity", file_fn) != napi_ok) {
    napi_throw_error(env, NULL, "cc-lhc identity: cannot register readFileIdentity");
    return NULL;
  }
  napi_value plat = make_string(env, IDENTITY_PLATFORM);
  napi_value contract = NULL;
  if (plat == NULL || napi_create_int32(env, IDENTITY_CONTRACT_VERSION, &contract) != napi_ok ||
      napi_set_named_property(env, exports, "platform", plat) != napi_ok ||
      napi_set_named_property(env, exports, "identityContractVersion", contract) != napi_ok) {
    napi_throw_error(env, NULL, "cc-lhc identity: cannot register module metadata");
    return NULL;
  }
  return exports;
}
