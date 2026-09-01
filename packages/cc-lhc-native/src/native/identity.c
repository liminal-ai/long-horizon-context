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

#else
#error "cc-lhc-native identity addon: unsupported platform"
#endif

#if defined(__linux__) || defined(__APPLE__)

#include <sys/stat.h>

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

#define IDENTITY_CONTRACT_VERSION 2
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

NAPI_MODULE_INIT() {
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
