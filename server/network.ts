import os from "node:os";
import net from "node:net";

const EXCLUDED_INTERFACE_PREFIXES = ["lo", "docker", "br-", "veth", "virbr", "vmnet", "tun", "tap"];
const PREFERRED_INTERFACE_PREFIXES = ["bond", "eth", "ens", "enp"];

function shouldSkipInterface(name: string) {
  return EXCLUDED_INTERFACE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function pickPreferredLanIp() {
  const interfaces = os.networkInterfaces();
  const candidates: Array<{ name: string; ip: string; score: number }> = [];

  for (const [name, addresses] of Object.entries(interfaces)) {
    if (!addresses || shouldSkipInterface(name)) {
      continue;
    }
    for (const address of addresses) {
      if (address.family !== "IPv4" || address.internal) {
        continue;
      }
      const preferredIndex = PREFERRED_INTERFACE_PREFIXES.findIndex((prefix) => name.startsWith(prefix));
      const score = preferredIndex === -1 ? 100 : preferredIndex;
      candidates.push({ name, ip: address.address, score });
    }
  }

  candidates.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return candidates[0]?.ip ?? "127.0.0.1";
}

export async function findAvailablePort(preferredPort: number, host = "0.0.0.0") {
  let port = preferredPort;

  while (port < preferredPort + 100) {
    const available = await isPortAvailable(port, host);
    if (available) {
      return port;
    }
    port += 1;
  }

  throw new Error(`No available port found from ${preferredPort} to ${preferredPort + 99}`);
}

function isPortAvailable(port: number, host: string) {
  return new Promise<boolean>((resolve, reject) => {
    const server = net.createServer();

    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") {
        resolve(false);
        return;
      }
      reject(error);
    });

    server.listen(port, host, () => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(true);
      });
    });
  });
}

export const networkTestables = {
  shouldSkipInterface,
  isPortAvailable,
};
