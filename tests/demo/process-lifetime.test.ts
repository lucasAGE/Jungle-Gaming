import { expect, test } from "bun:test";

test("a killed demo supervisor cannot leave its managed application process alive", async () => {
  const module = new URL("../../scripts/demo/processes.ts", import.meta.url).href;
  const workerCode = `import { exitWithParent } from ${JSON.stringify(module)};
    exitWithParent(); process.send("ready"); setInterval(() => {}, 1000);`;
  const parentCode = `Bun.spawn([process.execPath, "-e", ${JSON.stringify(workerCode)}], {
    ipc(message, child) { if (message === "ready") process.send({ pid: child.pid }); }, stdout: "ignore", stderr: "ignore"
  }); setInterval(() => {}, 1000);`;
  let announce: (pid: number) => void = () => {};
  const ready = new Promise<number>((resolve) => { announce = resolve; });
  const parent = Bun.spawn([process.execPath, "-e", parentCode], {
    ipc(message: { pid: number }) { announce(message.pid); }, stdout: "ignore", stderr: "ignore",
  });
  let workerPid: number | undefined;
  const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    workerPid = await Promise.race([ready, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Demonstration lifetime fixture did not start")), 5_000);
    })]);
    clearTimeout(timer);
    expect(alive(workerPid)).toBe(true);
    parent.kill("SIGKILL");
    await parent.exited;
    const deadline = Date.now() + 5_000;
    while (alive(workerPid) && Date.now() < deadline) await Bun.sleep(25);
    expect(alive(workerPid)).toBe(false);
  } finally {
    clearTimeout(timer);
    if (alive(parent.pid)) { parent.kill("SIGKILL"); await parent.exited; }
    if (workerPid !== undefined && alive(workerPid)) process.kill(workerPid, "SIGKILL");
  }
}, 12_000);
