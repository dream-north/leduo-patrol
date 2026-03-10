import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { findAvailablePort, networkTestables } from "../network.js";

test("network helper skips virtual/bridge interfaces", () => {
  assert.equal(networkTestables.shouldSkipInterface("lo"), true);
  assert.equal(networkTestables.shouldSkipInterface("br-f017ab"), true);
  assert.equal(networkTestables.shouldSkipInterface("vethf0aa"), true);
  assert.equal(networkTestables.shouldSkipInterface("bond0"), false);
  assert.equal(networkTestables.shouldSkipInterface("eth0"), false);
});


test("network helper findAvailablePort falls back when preferred port is occupied", async () => {
  const lockedServer = net.createServer();
  await new Promise<void>((resolve) => lockedServer.listen(0, "127.0.0.1", () => resolve()));

  const address = lockedServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve locked server address");
  }

  const fallbackPort = await findAvailablePort(address.port, "127.0.0.1");
  assert.notEqual(fallbackPort, address.port);

  await new Promise<void>((resolve, reject) =>
    lockedServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    }),
  );
});
