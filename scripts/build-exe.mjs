// Builds release/agent-office.exe: a self-extracting Windows launcher around
// the built CLI. Layout produced here: [launcher stub.exe][payload.zip][footer].
//
// The payload carries its own Node runtime, dist/, package.json and (when
// installed) the optional native pty module, so the exe needs nothing else on
// the target machine beyond the .NET Framework 4.x that ships with Windows.
// Paths inside dist/cli.js are resolved relative to itself (./web/,
// ./term-worker.mjs, ../package.json, ../../node_modules/@lydell), so the
// staged tree deliberately mirrors the repository layout.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const STAGE = join(ROOT, ".exe-stage");
const PAYLOAD = join(STAGE, "stage");
const ZIP = join(STAGE, "payload.zip");
const STUB = join(STAGE, "launcher-stub.exe");
const OUT_DIR = join(ROOT, "release");
const OUT = join(OUT_DIR, "agent-office.exe");

const log = (s) => process.stdout.write(`  ${s}\n`);

// 1. The exe always ships the current build.
if (!existsSync(join(ROOT, "dist", "cli.js"))) {
  log("dist/ missing - building first");
  execFileSync(process.execPath, [join(ROOT, "scripts", "build.mjs")], { cwd: ROOT, stdio: "inherit" });
}

// 2. Stage the portable tree.
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(join(PAYLOAD, "runtime"), { recursive: true });
cpSync(join(ROOT, "dist"), join(PAYLOAD, "dist"), { recursive: true });
cpSync(join(ROOT, "package.json"), join(PAYLOAD, "package.json"));
cpSync(process.execPath, join(PAYLOAD, "runtime", "node.exe"));
const pty = join(ROOT, "node_modules", "@lydell");
if (existsSync(pty)) {
  mkdirSync(join(PAYLOAD, "node_modules"), { recursive: true });
  cpSync(pty, join(PAYLOAD, "node_modules", "@lydell"), { recursive: true });
}
log("staged Node runtime + dist/ + optional native pty");

// 3. Zip it. zlib has no zip container, so use .NET's ZipFile via PowerShell;
//    -EncodedCommand avoids any quoting issues with paths containing spaces.
const ps = [
  "$ProgressPreference = 'SilentlyContinue';",
  "Add-Type -AssemblyName System.IO.Compression.FileSystem;",
  "[System.IO.Compression.ZipFile]::CreateFromDirectory($env:AO_SRC, $env:AO_DST, [System.IO.Compression.CompressionLevel]::Optimal, $false)",
].join(" ");
execFileSync("powershell.exe", ["-NoProfile", "-EncodedCommand", Buffer.from(ps, "utf16le").toString("base64")], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, AO_SRC: PAYLOAD, AO_DST: ZIP },
});
log(`payload.zip ${(statSync(ZIP).size / 1048576).toFixed(1)} MB`);

// 4. Compile the tiny C# stub (/target:winexe: no console window on double-click).
const win = process.env.WINDIR ?? "C:\\Windows";
const csc = [
  join(win, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
  join(win, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
].find(existsSync);
if (!csc) throw new Error("csc.exe (.NET Framework 4.x) not found");
const refs = ["System.Windows.Forms.dll", "System.Drawing.dll", "System.IO.Compression.dll"]
  .map((name) => "/r:" + (existsSync(join(dirname(csc), name)) ? join(dirname(csc), name) : name));
execFileSync(csc, [
  "/nologo", "/target:winexe", "/optimize+", "/platform:anycpu", "/out:" + STUB,
  ...refs, join(ROOT, "scripts", "launcher.cs"),
], { cwd: ROOT, stdio: "inherit" });
log("compiled launcher stub");

// 5. Append the payload and the fixed 32-byte footer the stub reads back.
const zip = readFileSync(ZIP);
const stub = readFileSync(STUB);
// A fresh id per build gives a fresh unpack directory, so a rebuilt exe never
// serves stale files. 16 ASCII bytes, safe as a directory name.
const buildId = ("ao" + Date.now().toString(36)).slice(0, 16).padEnd(16, "0");
const footer = Buffer.alloc(32);
footer.write("AOZIP001", 0, 8, "ascii");
footer.writeBigInt64LE(BigInt(zip.length), 8);
footer.write(buildId, 16, 16, "ascii");
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, Buffer.concat([stub, zip, footer]));

rmSync(STAGE, { recursive: true, force: true });
log("");
log(`built  ${OUT}`);
log(`size   ${(statSync(OUT).size / 1048576).toFixed(1)} MB`);
log("double-click it; right-click the tray icon to quit.");
log("pass --demo for the simulated office (default: your real agents).");
