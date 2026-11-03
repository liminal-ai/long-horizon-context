export const socketPath = (lhcHome: string, loadId: string): string => `${lhcHome}/run/${loadId}.sock`;
export const modLogPath = (lhcHome: string, loadId: string): string => `${lhcHome}/logs/mod-${loadId}.log`;
export const sidecarLogPath = (lhcHome: string, loadId: string): string => `${lhcHome}/logs/sidecar-${loadId}.log`;
