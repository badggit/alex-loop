#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/worktree-add/log.ts
import fs from "node:fs";
function formatTime(date) {
  return `${date.toISOString().slice(0, 19)}Z`;
}
function createLogger(write, clock) {
  const emit = (level, message) => {
    write(`${formatTime(clock())} ${level} ${message}`);
  };
  return {
    info: (message) => {
      emit("info", message);
    },
    warn: (message) => {
      emit("warn", message);
    },
    error: (message) => {
      emit("error", message);
    }
  };
}
function stderrLogger() {
  return createLogger(
    (line) => {
      fs.writeSync(2, `${line}
`);
    },
    () => /* @__PURE__ */ new Date()
  );
}
var init_log = __esm({
  "src/worktree-add/log.ts"() {
    "use strict";
  }
});

// src/worktree-add/text.ts
function isControlCharacter(character) {
  const code = character.codePointAt(0) ?? 0;
  return code < FIRST_PRINTABLE || code === DELETE;
}
function hasControlCharacter(value) {
  for (const character of value) {
    if (isControlCharacter(character)) {
      return true;
    }
  }
  return false;
}
function showText(value) {
  let shown = "";
  for (const character of value) {
    shown += isControlCharacter(character) ? "?" : character;
  }
  return shown;
}
var FIRST_PRINTABLE, DELETE;
var init_text = __esm({
  "src/worktree-add/text.ts"() {
    "use strict";
    FIRST_PRINTABLE = 32;
    DELETE = 127;
  }
});

// src/worktree-add/versions.ts
function nodeVersionProblem(version) {
  const match = NODE_VERSION.exec(version);
  const major = match?.[1] === void 0 ? Number.NaN : Number(match[1]);
  return major >= MIN_NODE_MAJOR ? void 0 : `Node ${String(MIN_NODE_MAJOR)} or newer is required, found ${showText(version)}`;
}
function shownGitVersion(line) {
  if (!line.startsWith(GIT_PREFIX)) {
    return showText(line);
  }
  const [word = ""] = line.slice(GIT_PREFIX.length).split(" ", 1);
  return showText(word);
}
function gitVersionProblem(versionOutput) {
  const [line = ""] = versionOutput.trim().split("\n", 1);
  const match = GIT_VERSION.exec(line);
  if (match?.[1] !== void 0 && match[2] !== void 0) {
    const major = Number(match[1]);
    const minor = Number(match[2]);
    if (major > MIN_GIT_MAJOR || major === MIN_GIT_MAJOR && minor >= MIN_GIT_MINOR) {
      return;
    }
  }
  return `git ${String(MIN_GIT_MAJOR)}.${String(MIN_GIT_MINOR)} or newer is required, found ${shownGitVersion(line)}`;
}
async function checkGitVersion(deps, cwd) {
  const result = await deps.runner.run({ file: "git", args: ["-C", cwd, "--version"] });
  if (result.spawnError !== void 0) {
    return "git is required but was not found";
  }
  if (result.code !== 0) {
    const [line = ""] = result.stderr.trim().split("\n", 1);
    const detail = line.length > 0 ? line : `git exited with code ${String(result.code)}`;
    return `cannot run git --version: ${showText(detail)}`;
  }
  return gitVersionProblem(result.stdout);
}
var MIN_NODE_MAJOR, MIN_GIT_MAJOR, MIN_GIT_MINOR, NODE_VERSION, GIT_VERSION, GIT_PREFIX;
var init_versions = __esm({
  "src/worktree-add/versions.ts"() {
    "use strict";
    init_text();
    MIN_NODE_MAJOR = 22;
    MIN_GIT_MAJOR = 2;
    MIN_GIT_MINOR = 29;
    NODE_VERSION = /^v?(\d+)\.\d+/u;
    GIT_VERSION = /^git version (\d+)\.(\d+)/u;
    GIT_PREFIX = "git version ";
  }
});

// src/worktree-add/args.ts
function isValueOption(arg) {
  return arg === "--suffix" || arg === "--parent";
}
function suffixProblem(suffix) {
  const shown = showText(suffix);
  if (suffix.length === 0 || suffix.length > MAX_SUFFIX) {
    return `the suffix must be 1 to ${String(MAX_SUFFIX)} characters long: ${shown}`;
  }
  if (!SUFFIX_PATTERN.test(suffix)) {
    return `the suffix must start with a-z or 0-9 and contain only a-z, 0-9, ".", "_" or "-": ${shown}`;
  }
  if (suffix.includes("..") || suffix.endsWith(".") || suffix.endsWith(".lock")) {
    return `the suffix must not contain ".." or end in "." or ".lock": ${shown}`;
  }
  return;
}
function expandParent(value, home) {
  if (value.length === 0) {
    return { ok: false, message: "the --parent value must not be empty" };
  }
  if (hasControlCharacter(value)) {
    return { ok: false, message: `the parent folder contains a control character: ${showText(value)}` };
  }
  if (value === "~" || value === "~/") {
    return { ok: true, parent: home };
  }
  if (value.startsWith("~/")) {
    return { ok: true, parent: `${home}/${value.slice(2)}` };
  }
  if (value.startsWith("~")) {
    return { ok: false, message: `only ~ and ~/ are expanded: ${showText(value)}` };
  }
  return { ok: true, parent: value };
}
function usage(message) {
  return { kind: "usage", message };
}
function parseArgs(argv, home) {
  if (argv.includes("--help")) {
    return { kind: "help" };
  }
  const values = {};
  let install = true;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === NO_INSTALL) {
      if (!install) {
        return usage(`${NO_INSTALL} can be given only once`);
      }
      install = false;
      continue;
    }
    if (!isValueOption(arg)) {
      return usage(
        arg.startsWith("-") ? `unknown option: ${showText(arg)}` : `unexpected argument: ${showText(arg)}`
      );
    }
    if (values[arg] !== void 0) {
      return usage(`${arg} can be given only once`);
    }
    const value = argv[index + 1];
    if (value === void 0) {
      return usage(`missing value for ${arg}`);
    }
    values[arg] = value;
    index += 1;
  }
  const suffix = values["--suffix"];
  if (suffix === void 0) {
    return usage("--suffix SUFFIX is required");
  }
  const problem2 = suffixProblem(suffix);
  if (problem2 !== void 0) {
    return usage(problem2);
  }
  const parentValue = values["--parent"];
  if (parentValue === void 0) {
    return { kind: "ok", suffix, parent: void 0, install };
  }
  const expanded = expandParent(parentValue, home);
  return expanded.ok ? { kind: "ok", suffix, parent: expanded.parent, install } : usage(expanded.message);
}
function usageText() {
  return [
    "Usage: worktree-add.mjs --suffix SUFFIX [--parent DIR] [--no-install]",
    "",
    "Creates or reuses the sibling git worktree MAIN-SUFFIX on the branch SUFFIX and prints its absolute path.",
    "",
    `  --suffix SUFFIX  1 to ${String(MAX_SUFFIX)} characters: a-z or 0-9 first, then a-z, 0-9, ".", "_" or "-"`,
    "  --parent DIR     folder for the worktree (default: the main clone's parent folder);",
    "                   a leading ~ or ~/ is expanded to the home folder, other ~ forms are refused",
    "  --no-install     skip the dependency installs; dependency folders are cloned or linked instead",
    "  --help           show this help",
    "",
    "Exit codes: 0 success (the path on stdout), 1 refusal or error, 2 wrong arguments.",
    ""
  ].join("\n");
}
var NO_INSTALL, MAX_SUFFIX, SUFFIX_PATTERN;
var init_args = __esm({
  "src/worktree-add/args.ts"() {
    "use strict";
    init_text();
    NO_INSTALL = "--no-install";
    MAX_SUFFIX = 100;
    SUFFIX_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;
  }
});

// src/worktree-add/paths.ts
import fs2 from "node:fs";
import path from "node:path";
function canonical(file) {
  try {
    return fs2.realpathSync.native(file);
  } catch {
    return file;
  }
}
function lstatOrUndefined(file) {
  try {
    return fs2.lstatSync(file);
  } catch {
    return;
  }
}
function isDirectory(file) {
  return lstatOrUndefined(file)?.isDirectory() === true;
}
function canonicalLoose(file) {
  const absolute = path.isAbsolute(file) ? file : `${process.cwd()}/${file}`;
  let current = "/";
  let exists = true;
  for (const part of absolute.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      current = path.dirname(current);
      if (!exists && isDirectory(current)) {
        exists = true;
      }
      continue;
    }
    const next = path.join(current, part);
    if (exists) {
      try {
        current = fs2.realpathSync.native(next);
        continue;
      } catch {
        exists = false;
      }
    }
    current = next;
  }
  return current;
}
function isLinkWithText(file, text) {
  if (lstatOrUndefined(file)?.isSymbolicLink() !== true) {
    return false;
  }
  try {
    return fs2.readlinkSync(file) === text;
  } catch {
    return false;
  }
}
function realOrUndefined(file) {
  try {
    return fs2.realpathSync.native(file);
  } catch {
    return;
  }
}
function parentInside(root, rel) {
  const realRoot = realOrUndefined(root);
  const parent = realOrUndefined(path.dirname(path.join(root, rel)));
  return realRoot !== void 0 && parent === path.join(realRoot, path.dirname(rel));
}
var init_paths = __esm({
  "src/worktree-add/paths.ts"() {
    "use strict";
  }
});

// src/worktree-add/place.ts
import fs3 from "node:fs";
import path2 from "node:path";
function errorCode(error) {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "unknown";
}
function removeQuietly(file) {
  try {
    fs3.rmSync(file, { recursive: true, force: true });
  } catch {
    return;
  }
}
function isAlive(alive, pid) {
  try {
    return alive(pid);
  } catch {
    return true;
  }
}
function tempName(dir, pid) {
  let counter = 1;
  let temp = path2.join(dir, `${TEMP_PREFIX}${String(pid)}-${String(counter)}`);
  while (lstatOrUndefined(temp) !== void 0) {
    counter += 1;
    temp = path2.join(dir, `${TEMP_PREFIX}${String(pid)}-${String(counter)}`);
  }
  return temp;
}
function sweepDeadTemps(dir, alive, ownPid) {
  let names;
  try {
    names = fs3.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const match = TEMP_NAME_PATTERN.exec(name);
    if (match === null) {
      continue;
    }
    const pid = Number(match[1]);
    if (pid === ownPid || isAlive(alive, pid)) {
      continue;
    }
    removeQuietly(path2.join(dir, name));
  }
}
function entrySizeKb(file) {
  let total = 0;
  const pending = [file];
  let next = pending.pop();
  while (next !== void 0) {
    const stat = lstatOrUndefined(next);
    if (stat !== void 0) {
      total += stat.size;
      if (stat.isDirectory()) {
        const dir = next;
        try {
          for (const name of fs3.readdirSync(dir)) {
            pending.push(path2.join(dir, name));
          }
        } catch {
        }
      }
    }
    next = pending.pop();
  }
  return Math.ceil(total / 1024);
}
function cpFile(platform) {
  return platform === "darwin" ? "/bin/cp" : "cp";
}
function cpFailure(result) {
  const firstLine = result.stderr.split("\n", 1)[0] ?? "";
  const detail = firstLine === "" ? result.spawnError : firstLine;
  const reason = `cp exited with ${String(result.code)}`;
  return detail ? `${reason}: ${showText(detail)}` : reason;
}
function restoreOwnLink(dest, ownLinkText) {
  if (lstatOrUndefined(dest) !== void 0) {
    return;
  }
  try {
    fs3.symlinkSync(ownLinkText, dest);
  } catch {
  }
}
function moveIntoPlace(temp, request, rename) {
  const { dest, ownLinkText } = request;
  const replacesOwnLink = isLinkWithText(dest, ownLinkText);
  if (!replacesOwnLink && lstatOrUndefined(dest) !== void 0) {
    return { ok: false, reason: `something appeared at ${showText(dest)}` };
  }
  try {
    if (replacesOwnLink) {
      fs3.unlinkSync(dest);
    }
    rename(temp, dest);
    return { ok: true };
  } catch (error) {
    if (replacesOwnLink) {
      restoreOwnLink(dest, ownLinkText);
    }
    return { ok: false, reason: `cannot rename the copy into place (${errorCode(error)})` };
  }
}
async function placeCopy(deps, request, rename = fs3.renameSync) {
  const temp = tempName(path2.dirname(request.dest), deps.pid);
  deps.temps.add(temp);
  try {
    const result = await deps.runner.run({
      file: cpFile(deps.platform),
      args: ["-R", "-P", "-p", ...request.cloneFlags, request.source, temp]
    });
    if (result.code !== 0 || result.spawnError !== void 0) {
      return { ok: false, reason: cpFailure(result) };
    }
    if (lstatOrUndefined(temp) === void 0) {
      return { ok: false, reason: "cp exited with 0 but created nothing" };
    }
    return moveIntoPlace(temp, request, rename);
  } finally {
    removeQuietly(temp);
    deps.temps.remove(temp);
  }
}
var TEMP_PREFIX, TEMP_NAME_PATTERN;
var init_place = __esm({
  "src/worktree-add/place.ts"() {
    "use strict";
    init_paths();
    init_text();
    TEMP_PREFIX = ".alex-loop-tmp-";
    TEMP_NAME_PATTERN = /^\.alex-loop-tmp-(\d+)-\d+$/u;
  }
});

// src/worktree-add/cowGate.ts
import fs4 from "node:fs";
import path3 from "node:path";
function cloneFlags(platform) {
  if (platform === "linux") {
    return ["--reflink=always"];
  }
  if (platform === "darwin") {
    return ["-c"];
  }
  return;
}
function parseDfMount(stdout) {
  const line = stdout.split("\n", 2)[1]?.replace(/\r$/, "").trimStart();
  if (!line) {
    return;
  }
  const match = DF_LINE.exec(line);
  const device = match?.[1];
  const mountPoint = match?.[2];
  if (!device || !mountPoint?.startsWith("/")) {
    return;
  }
  return { device, mountPoint };
}
function isApfsMount(mountStdout, mount) {
  const prefix = `${mount.device} on ${mount.mountPoint} (`;
  return mountStdout.split("\n").some((line) => {
    if (!line.startsWith(prefix)) {
      return false;
    }
    const fsType = line.slice(prefix.length).split(/[),]/, 1)[0]?.trim();
    return fsType === "apfs";
  });
}
function readEntries(dir) {
  try {
    return fs4.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
function findSampleFile(dir, limit = SAMPLE_ENTRY_LIMIT) {
  const queue = [path3.resolve(dir)];
  let seen = 0;
  for (const current of queue) {
    for (const entry of readEntries(current)) {
      if (seen >= limit) {
        return;
      }
      seen += 1;
      const full = path3.join(current, entry.name);
      if (entry.isFile()) {
        return full;
      }
      if (entry.isDirectory()) {
        queue.push(full);
      }
    }
  }
  return;
}
function defaultDeviceOf(file) {
  try {
    return fs4.statSync(file).dev;
  } catch {
    return;
  }
}
function sampleUnder(source) {
  const stat = lstatOrUndefined(source);
  if (stat?.isFile()) {
    return source;
  }
  return stat?.isDirectory() ? findSampleFile(source) : void 0;
}
function removeQuietly2(file) {
  try {
    fs4.rmSync(file, { recursive: true, force: true });
  } catch {
    return;
  }
}
async function probeLinux(deps, sample, destination) {
  const probe = tempName(destination, deps.pid);
  deps.temps.add(probe);
  try {
    const result = await deps.runner.run({
      file: cpFile("linux"),
      args: [...cloneFlags("linux") ?? [], sample, probe]
    });
    return result.code === 0 && result.spawnError === void 0 ? AVAILABLE : NO_COW;
  } finally {
    removeQuietly2(probe);
    deps.temps.remove(probe);
  }
}
function darwinTool(tool, args) {
  return { file: "/usr/bin/env", args: ["LC_ALL=C", tool, ...args] };
}
async function checkDarwin(deps, worktree) {
  const df = await deps.runner.run(darwinTool("/bin/df", ["-P", worktree]));
  const mount = await deps.runner.run(darwinTool("/sbin/mount", []));
  if (df.code !== 0 || mount.code !== 0 || df.spawnError !== void 0 || mount.spawnError !== void 0) {
    return VOLUME_READ_FAILURE;
  }
  const volume = parseDfMount(df.stdout);
  if (!volume) {
    return VOLUME_READ_FAILURE;
  }
  return isApfsMount(mount.stdout, volume) ? AVAILABLE : NOT_APFS;
}
function sameVolume(deviceOf, files) {
  const devices = files.map((file) => deviceOf(file));
  const first = devices[0];
  return first !== void 0 && devices.every((device) => device === first);
}
function createCloneGate(env) {
  const deviceOf = env?.deviceOf ?? defaultDeviceOf;
  const cache = /* @__PURE__ */ new Map();
  return {
    async check(deps, request) {
      if (deps.platform !== "linux" && deps.platform !== "darwin") {
        return UNSUPPORTED;
      }
      const source = path3.join(request.main, request.rel);
      const destination = path3.dirname(path3.join(request.worktree, request.rel));
      if (deps.platform === "darwin" && !sameVolume(deviceOf, [source, request.worktree, destination])) {
        return DIFFERENT_VOLUMES;
      }
      const key = `${request.main}\0${request.worktree}`;
      const cached = cache.get(key);
      if (cached) {
        return cached;
      }
      let result;
      if (deps.platform === "darwin") {
        result = await checkDarwin(deps, request.worktree);
      } else {
        const sample = sampleUnder(source);
        if (sample === void 0) {
          return AVAILABLE;
        }
        result = await probeLinux(deps, sample, destination);
      }
      cache.set(key, result);
      return result;
    }
  };
}
var SAMPLE_ENTRY_LIMIT, DF_LINE, UNSUPPORTED, DIFFERENT_VOLUMES, NOT_APFS, VOLUME_READ_FAILURE, NO_COW, AVAILABLE;
var init_cowGate = __esm({
  "src/worktree-add/cowGate.ts"() {
    "use strict";
    init_paths();
    init_place();
    SAMPLE_ENTRY_LIMIT = 1e3;
    DF_LINE = /^(\S+)\s+\S+\s+\S+\s+\S+\s+\S*%\s+(\S.*)$/;
    UNSUPPORTED = {
      kind: "unavailable",
      reason: "copy-on-write clones are not supported on this platform"
    };
    DIFFERENT_VOLUMES = {
      kind: "unavailable",
      reason: "the clone and the worktree are on different volumes"
    };
    NOT_APFS = { kind: "unavailable", reason: "the worktree volume is not APFS" };
    VOLUME_READ_FAILURE = { kind: "unavailable", reason: "cannot read the volume type" };
    NO_COW = { kind: "unavailable", reason: "no copy-on-write between the clone and the worktree" };
    AVAILABLE = { kind: "available" };
  }
});

// src/worktree-add/worktrees.ts
import fs5 from "node:fs";
import path4 from "node:path";
function errorCode2(error) {
  return error instanceof Error && "code" in error ? error.code : void 0;
}
function hasFlag(line, flag) {
  return line === flag || line.startsWith(`${flag} `);
}
function parseWorktreeList(text) {
  const entries = [];
  let current;
  for (const line of text.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = {
        path: line.slice("worktree ".length),
        branch: void 0,
        bare: false,
        detached: false,
        locked: false,
        prunable: false
      };
      entries.push(current);
    } else if (current !== void 0) {
      if (line.startsWith(BRANCH_LINE_PREFIX)) {
        current.branch = line.slice(BRANCH_LINE_PREFIX.length);
      } else if (line === "bare") {
        current.bare = true;
      } else if (line === "detached") {
        current.detached = true;
      } else if (hasFlag(line, "locked")) {
        current.locked = true;
      } else if (hasFlag(line, "prunable")) {
        current.prunable = true;
      }
    }
  }
  return entries;
}
async function listWorktrees(deps, dir) {
  const listed = await deps.runner.run({ file: "git", args: ["-C", dir, "worktree", "list", "--porcelain"] });
  return listed.code === 0 && listed.spawnError === void 0 ? parseWorktreeList(listed.stdout) : void 0;
}
function matchesTarget(entryPath, target) {
  return entryPath === target || canonicalLoose(entryPath) === canonicalLoose(target);
}
function readSingleLine(file) {
  let text;
  try {
    text = fs5.readFileSync(file, "utf8");
  } catch {
    return;
  }
  const line = text.endsWith("\n") ? text.slice(0, -1) : text;
  return line.length === 0 || line.includes("\n") ? void 0 : line;
}
function linksBack(adminDir, dotGit) {
  const record = readSingleLine(path4.join(adminDir, "gitdir"));
  return record !== void 0 && canonicalLoose(path4.resolve(adminDir, record)) === canonicalLoose(dotGit);
}
function lockMarkerState(adminDir) {
  try {
    fs5.lstatSync(path4.join(adminDir, "locked"));
    return "locked";
  } catch (error) {
    return errorCode2(error) === "ENOENT" ? "unlocked" : "unknown";
  }
}
function lockStateOfFolder(worktreePath, commonDir, isMain) {
  const dotGit = path4.join(worktreePath, ".git");
  if (lstatOrUndefined(dotGit)?.isDirectory() === true) {
    return "unlocked";
  }
  let text;
  try {
    text = fs5.readFileSync(dotGit, "utf8");
  } catch {
    return "unknown";
  }
  const pointer = GITDIR_LINE.exec(text)?.[1];
  if (pointer === void 0) {
    return "unknown";
  }
  const adminDir = path4.resolve(worktreePath, pointer);
  if (isMain && canonicalLoose(adminDir) === canonicalLoose(commonDir)) {
    return "unlocked";
  }
  return linksBack(adminDir, dotGit) ? lockMarkerState(adminDir) : "unknown";
}
function lockStateOfMissing(worktreePath, commonDir) {
  const adminRoot = path4.join(commonDir, "worktrees");
  let names;
  try {
    names = fs5.readdirSync(adminRoot);
  } catch {
    return "unknown";
  }
  const dotGit = path4.join(worktreePath, ".git");
  for (const name of names) {
    const adminDir = path4.join(adminRoot, name);
    if (linksBack(adminDir, dotGit)) {
      return lockMarkerState(adminDir);
    }
  }
  return "unknown";
}
function lockState(entry, commonDir, isMain = false) {
  if (entry.locked) {
    return "locked";
  }
  if (entry.bare) {
    return "unlocked";
  }
  return lstatOrUndefined(entry.path) === void 0 ? lockStateOfMissing(entry.path, commonDir) : lockStateOfFolder(entry.path, commonDir, isMain);
}
var BRANCH_LINE_PREFIX, GITDIR_LINE;
var init_worktrees = __esm({
  "src/worktree-add/worktrees.ts"() {
    "use strict";
    init_paths();
    BRANCH_LINE_PREFIX = "branch refs/heads/";
    GITDIR_LINE = /^gitdir: (.+?)\r?\n?$/u;
  }
});

// src/worktree-add/create.ts
import fs6 from "node:fs";
import path5 from "node:path";
function git(deps, dir, args) {
  return deps.runner.run({ file: "git", args: ["-C", dir, ...args] });
}
function succeeded(result) {
  return result.code === 0 && result.spawnError === void 0;
}
function errorLine(result) {
  if (result.spawnError !== void 0) {
    return showText(result.spawnError);
  }
  const [first = ""] = result.stderr.trim().split("\n", 1);
  const line = first.trim();
  return line.length > 0 ? showText(line) : `git exited with code ${String(result.code)}`;
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
async function commitOf(deps, dir, ref) {
  const result = await git(deps, dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  const sha = result.stdout.trim();
  return succeeded(result) && sha.length > 0 ? sha : void 0;
}
async function createBranchAt(deps, dir, branch, sha, tracked) {
  const created = await git(deps, dir, ["branch", "--no-track", branch, sha]);
  return succeeded(created) ? { ok: true, owned: { sha, tracked } } : { ok: false, reason: errorLine(created) };
}
async function createTrackedBranch(deps, dir, branch, remote) {
  const upstream = `${remote}/${branch}`;
  const sha = await commitOf(deps, dir, `refs/remotes/${upstream}`);
  if (sha === void 0) {
    return { ok: false, reason: `cannot resolve the remote branch ${showText(upstream)}` };
  }
  return createBranchAt(deps, dir, branch, sha, true);
}
function createBranch(deps, dir, branch, step) {
  switch (step.kind) {
    case "create": {
      return createBranchAt(deps, dir, branch, step.start.sha, false);
    }
    case "track": {
      return createTrackedBranch(deps, dir, branch, step.remote);
    }
    case "checkout":
    case "reuse": {
      return Promise.resolve({ ok: true, owned: void 0 });
    }
  }
}
async function rollbackBranch(deps, dir, branch, owned) {
  const deleted = await git(deps, dir, [
    "update-ref",
    "--no-deref",
    "-d",
    `${BRANCH_REF_PREFIX}${branch}`,
    owned.sha
  ]);
  if (!succeeded(deleted)) {
    deps.log.warn(`branch ${showText(branch)} was kept: ${errorLine(deleted)}`);
    return;
  }
  if (!owned.tracked) {
    return;
  }
  for (const key of UPSTREAM_KEYS) {
    const unset = await git(deps, dir, ["config", "--unset", `branch.${branch}.${key}`]);
    if (!succeeded(unset) && unset.code !== CONFIG_KEY_ABSENT) {
      deps.log.warn(`cannot remove branch.${showText(branch)}.${key}: ${errorLine(unset)}`);
    }
  }
}
function removeCreatedParents(parent, createdTop) {
  if (createdTop === void 0) {
    return;
  }
  let dir = parent;
  for (; ; ) {
    try {
      fs6.rmdirSync(dir);
    } catch {
      return;
    }
    const up = path5.dirname(dir);
    if (dir === createdTop || up === dir) {
      return;
    }
    dir = up;
  }
}
async function abandon(deps, repo, target, owned, reason, createdTop) {
  const shownBranch = showText(target.branch);
  const entries = await listWorktrees(deps, repo.current);
  if (entries === void 0) {
    return { ok: false, reason: owned === void 0 ? reason : `${reason}; branch ${shownBranch} was kept` };
  }
  const registered = entries.find((entry) => matchesTarget(entry.path, target.path));
  if (registered !== void 0) {
    const onBranch = registered.branch === void 0 ? "a detached HEAD" : showText(registered.branch);
    return {
      ok: false,
      reason: `the worktree exists at ${showText(target.path)} on ${onBranch} but git reported an error: ${reason}`
    };
  }
  removeCreatedParents(target.parent, createdTop);
  if (owned !== void 0) {
    if (entries.some((entry) => entry.branch === target.branch)) {
      deps.log.warn(`branch ${shownBranch} was kept: a worktree has it checked out`);
    } else {
      await rollbackBranch(deps, repo.current, target.branch, owned);
    }
  }
  return { ok: false, reason };
}
async function setUpstream(deps, dir, branch, remote) {
  const upstream = `${remote}/${branch}`;
  const tracking = await git(deps, dir, ["branch", `--set-upstream-to=refs/remotes/${upstream}`, branch]);
  if (succeeded(tracking)) {
    return;
  }
  return `cannot set the upstream of ${showText(branch)} to ${showText(upstream)}: ${errorLine(tracking)}`;
}
function createParent(deps, parent) {
  try {
    const createdTop = fs6.mkdirSync(parent, { recursive: true });
    deps.log.info(`created parent folder ${showText(parent)}`);
    return { ok: true, createdTop };
  } catch (error) {
    return {
      ok: false,
      reason: `cannot create the parent folder ${showText(parent)}: ${showText(errorMessage(error))}`
    };
  }
}
function createdMessage(target, step) {
  const shownPath = showText(target.path);
  const shownBranch = showText(target.branch);
  switch (step.kind) {
    case "create": {
      const short = step.start.sha.slice(0, SHORT_SHA_LENGTH);
      return `created worktree ${shownPath} on new branch ${shownBranch} from ${showText(step.start.label)} @ ${showText(short)}`;
    }
    case "track": {
      return `created worktree ${shownPath} on new branch ${shownBranch} tracking ${showText(step.remote)}/${shownBranch}`;
    }
    case "checkout":
    case "reuse": {
      return `created worktree ${shownPath} on existing branch ${shownBranch}`;
    }
  }
}
async function applyStep(deps, repo, target, step) {
  if (step.kind === "reuse") {
    deps.log.info(`reusing worktree ${showText(target.path)} on ${showText(target.branch)}`);
    return { ok: true };
  }
  const dir = repo.current;
  const branch = await createBranch(deps, dir, target.branch, step);
  if (!branch.ok) {
    return branch;
  }
  if (step.kind === "track") {
    const failed = await setUpstream(deps, dir, target.branch, step.remote);
    if (failed !== void 0) {
      return abandon(deps, repo, target, branch.owned, failed);
    }
  }
  let createdTop;
  if (target.parentMissing) {
    const parent = createParent(deps, target.parent);
    if (!parent.ok) {
      return abandon(deps, repo, target, branch.owned, parent.reason);
    }
    createdTop = parent.createdTop;
  }
  const added = await git(deps, dir, ["worktree", "add", "--quiet", target.path, target.branch]);
  if (!succeeded(added)) {
    return abandon(deps, repo, target, branch.owned, errorLine(added), createdTop);
  }
  deps.log.info(createdMessage(target, step));
  return { ok: true };
}
var BRANCH_REF_PREFIX, SHORT_SHA_LENGTH, CONFIG_KEY_ABSENT, UPSTREAM_KEYS;
var init_create = __esm({
  "src/worktree-add/create.ts"() {
    "use strict";
    init_text();
    init_worktrees();
    BRANCH_REF_PREFIX = "refs/heads/";
    SHORT_SHA_LENGTH = 7;
    CONFIG_KEY_ABSENT = 5;
    UPSTREAM_KEYS = ["remote", "merge"];
  }
});

// src/worktree-add/decide.ts
function refuse(reason) {
  return { kind: "refuse", reason };
}
function remoteOf(match, branch) {
  const suffix = `/${branch}`;
  return match.endsWith(suffix) && match.length > suffix.length ? match.slice(0, -suffix.length) : void 0;
}
function decideRegistered(facts, registered) {
  const target = showText(facts.target);
  const branch = showText(facts.branch);
  if (registered.bare) {
    return refuse(`${target} is registered as a bare repository, not a worktree`);
  }
  if (registered.missing && registered.locked) {
    return refuse(
      `${target} is a locked worktree whose folder is missing; run git worktree unlock ${target}, then git worktree prune`
    );
  }
  if (registered.missing) {
    return refuse(`${target} is a registered worktree whose folder is missing; run git worktree prune first`);
  }
  if (registered.locked) {
    return refuse(`${target} is a locked worktree`);
  }
  if (registered.detached || registered.branch === void 0) {
    return refuse(`${target} is a worktree on a detached HEAD, not on branch ${branch}`);
  }
  if (registered.branch !== facts.branch) {
    return refuse(`${target} is a worktree on branch ${showText(registered.branch)}, not on ${branch}`);
  }
  return { kind: "reuse" };
}
function decideBranch(facts) {
  const branch = showText(facts.branch);
  if (facts.localBranch) {
    return { kind: "checkout" };
  }
  if (facts.remoteMatches.length > 1) {
    const candidates = facts.remoteMatches.map((match) => showText(match)).join(", ");
    return refuse(`branch ${branch} exists on several remotes (${candidates}); create it locally first`);
  }
  const [onlyMatch] = facts.remoteMatches;
  if (onlyMatch === void 0) {
    return { kind: "create" };
  }
  const remote = remoteOf(onlyMatch, facts.branch);
  return remote === void 0 ? refuse(`cannot tell the remote of ${showText(onlyMatch)} for branch ${branch}`) : { kind: "track", remote };
}
function decideWorktree(facts) {
  const target = showText(facts.target);
  if (facts.targetIsMain) {
    return refuse(`${target} is the main working tree`);
  }
  if (facts.targetState === "symlink") {
    return refuse(`${target} is a symlink; refusing to follow it`);
  }
  if (facts.targetState === "unreadable") {
    return refuse(`cannot read ${target}`);
  }
  if (facts.registered !== void 0) {
    return decideRegistered(facts, facts.registered);
  }
  if (facts.targetState === "present") {
    return refuse(`something already exists at ${target}`);
  }
  if (facts.holder !== void 0) {
    return refuse(`branch ${showText(facts.branch)} is checked out in another worktree: ${showText(facts.holder)}`);
  }
  return decideBranch(facts);
}
var init_decide = __esm({
  "src/worktree-add/decide.ts"() {
    "use strict";
    init_text();
  }
});

// src/worktree-add/facts.ts
import fs7 from "node:fs";
import path6 from "node:path";
function errorCode3(error) {
  return error instanceof Error && "code" in error ? error.code : void 0;
}
function git2(deps, dir, args) {
  return deps.runner.run({ file: "git", args: ["-C", dir, ...args] });
}
function succeeded2(result) {
  return result.code === 0 && result.spawnError === void 0;
}
function failureLine(result) {
  if (result.spawnError !== void 0) {
    return result.spawnError;
  }
  const line = result.stderr.split("\n", 1)[0]?.trim() ?? "";
  return line.length > 0 ? line : `git exited with code ${String(result.code)}`;
}
function targetStateOf(target) {
  try {
    return fs7.lstatSync(target).isSymbolicLink() ? "symlink" : "present";
  } catch (error) {
    return errorCode3(error) === "ENOENT" ? "absent" : "unreadable";
  }
}
function findRegistered(entries, target) {
  return entries.find((entry) => entry.path === target) ?? entries.find((entry) => matchesTarget(entry.path, target));
}
async function commonDirOf(deps, dir) {
  const result = await git2(deps, dir, ["rev-parse", "--git-common-dir"]);
  const printed2 = result.stdout.trim();
  if (!succeeded2(result) || printed2.length === 0) {
    return { ok: false, reason: "cannot find the git folder of the repository" };
  }
  return { ok: true, dir: path6.resolve(dir, printed2) };
}
function describeRegistered(entry, commonDir, isMain) {
  const folderExists = lstatOrUndefined(entry.path) !== void 0;
  const state = lockState(entry, commonDir, isMain);
  return {
    path: entry.path,
    branch: entry.branch,
    bare: entry.bare,
    detached: entry.detached,
    // Fails closed before a reuse: a lock state that cannot be confirmed counts as locked while the folder exists.
    locked: state === "locked" || state === "unknown" && folderExists,
    missing: entry.prunable || !folderExists
  };
}
async function checkRef(deps, dir, ref, kind) {
  const result = await git2(deps, dir, ["show-ref", "--verify", "--quiet", ref]);
  if (result.spawnError === void 0 && (result.code === 0 || result.code === REF_ABSENT_CODE)) {
    return { ok: true, exists: result.code === 0 };
  }
  return { ok: false, reason: `cannot check ${kind} ${showText(ref)}: ${showText(failureLine(result))}` };
}
async function remoteMatchesOf(deps, dir, branch) {
  const listed = await git2(deps, dir, ["remote"]);
  if (!succeeded2(listed)) {
    return { ok: false, reason: "cannot list the remotes of the repository" };
  }
  const matches = [];
  const remotes = listed.stdout.split("\n").filter((line) => line.length > 0);
  for (const remote of remotes) {
    const check = await checkRef(deps, dir, `refs/remotes/${remote}/${branch}`, "remote branch");
    if (!check.ok) {
      return check;
    }
    if (check.exists) {
      matches.push(`${remote}/${branch}`);
    }
  }
  return { ok: true, matches };
}
async function gatherFacts(deps, repo, target) {
  const { current } = repo;
  const entries = await listWorktrees(deps, current);
  if (entries === void 0) {
    return { ok: false, reason: "cannot list the worktrees of the repository" };
  }
  const remote = await remoteMatchesOf(deps, current, target.branch);
  if (!remote.ok) {
    return remote;
  }
  const local = await checkRef(deps, current, `refs/heads/${target.branch}`, "branch");
  if (!local.ok) {
    return local;
  }
  const entry = findRegistered(entries, target.path);
  let registered;
  if (entry !== void 0) {
    const common = await commonDirOf(deps, current);
    if (!common.ok) {
      return common;
    }
    registered = describeRegistered(entry, common.dir, entry === entries[0]);
  }
  const holder = entries.find((other) => other !== entry && other.branch === target.branch);
  return {
    ok: true,
    facts: {
      target: target.path,
      branch: target.branch,
      targetIsMain: canonical(target.path) === canonical(repo.main),
      targetState: targetStateOf(target.path),
      registered,
      holder: holder?.path,
      localBranch: local.exists,
      remoteMatches: remote.matches
    }
  };
}
var REF_ABSENT_CODE;
var init_facts = __esm({
  "src/worktree-add/facts.ts"() {
    "use strict";
    init_paths();
    init_text();
    init_worktrees();
    REF_ABSENT_CODE = 1;
  }
});

// src/worktree-add/repo.ts
import path7 from "node:path";
function gitIn(deps, dir, args) {
  return deps.runner.run({ file: "git", args: ["-C", dir, ...args] });
}
function withoutFinalNewline(text) {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}
function failureLine2(result) {
  if (result.spawnError !== void 0) {
    return showText(result.spawnError);
  }
  const [first = ""] = result.stderr.trim().split("\n", 1);
  return first.length > 0 ? showText(first) : `git exited with code ${String(result.code)}`;
}
async function canonicalDir(deps, dir, flag) {
  const result = await gitIn(deps, dir, ["rev-parse", flag]);
  const value = withoutFinalNewline(result.stdout);
  return result.code === 0 && value.length > 0 ? canonical(path7.resolve(dir, value)) : void 0;
}
async function gitDirsOf(deps, dir) {
  const gitDir = await canonicalDir(deps, dir, "--absolute-git-dir");
  const commonDir = await canonicalDir(deps, dir, "--git-common-dir");
  return gitDir === void 0 || commonDir === void 0 ? void 0 : { gitDir, commonDir };
}
async function confirmedMainTree(deps, dir, commonDir) {
  const [first] = await listWorktrees(deps, dir) ?? [];
  if (first === void 0 || first.bare) {
    return;
  }
  const entry = canonical(first.path);
  const toplevel = await canonicalDir(deps, entry, "--show-toplevel");
  const entryCommon = await canonicalDir(deps, entry, "--git-common-dir");
  return toplevel === entry && entryCommon === commonDir ? entry : void 0;
}
async function linkedLayout(deps, current, commonDir) {
  const main2 = await confirmedMainTree(deps, current, commonDir);
  return main2 === void 0 ? { current, main: current, mainFound: false, linked: true } : { current, main: main2, mainFound: true, linked: true };
}
async function superprojectRefusal(deps, dir) {
  const result = await gitIn(deps, dir, ["rev-parse", "--show-superproject-working-tree"]);
  if (result.code !== 0) {
    return `cannot check whether ${showText(dir)} is inside a superproject: ${failureLine2(result)}`;
  }
  const superproject = withoutFinalNewline(result.stdout);
  if (superproject.length === 0) {
    return;
  }
  return `the main working tree ${showText(dir)} is a submodule; a sibling worktree would land inside the superproject ${showText(superproject)}`;
}
async function locateRepository(deps, cwd) {
  const dir = canonical(cwd);
  const shownCwd = showText(cwd);
  const inside = await gitIn(deps, dir, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0) {
    return { ok: false, reason: `not a git repository: ${shownCwd}` };
  }
  if (inside.stdout.trim() !== "true") {
    return { ok: false, reason: `not inside a git working tree: ${shownCwd}` };
  }
  const current = await canonicalDir(deps, dir, "--show-toplevel");
  if (current === void 0) {
    return { ok: false, reason: `not a git repository: ${shownCwd}` };
  }
  const dirs = await gitDirsOf(deps, current);
  if (dirs === void 0) {
    return { ok: false, reason: `cannot read the git directories of ${showText(current)}` };
  }
  if (dirs.gitDir !== dirs.commonDir) {
    return { ok: true, repo: await linkedLayout(deps, current, dirs.commonDir) };
  }
  const reason = await superprojectRefusal(deps, current);
  if (reason !== void 0) {
    return { ok: false, reason };
  }
  return { ok: true, repo: { current, main: current, mainFound: true, linked: false } };
}
async function checkBranchName(deps, dir, branch) {
  const result = await gitIn(deps, dir, ["check-ref-format", `refs/heads/${branch}`]);
  if (result.spawnError === void 0 && result.code === 0) {
    return "valid";
  }
  if (result.spawnError === void 0 && result.code === BRANCH_REJECTED_CODE) {
    return "invalid";
  }
  return { error: `cannot check the branch name ${showText(branch)}: ${failureLine2(result)}` };
}
var BRANCH_REJECTED_CODE;
var init_repo = __esm({
  "src/worktree-add/repo.ts"() {
    "use strict";
    init_paths();
    init_text();
    init_worktrees();
    BRANCH_REJECTED_CODE = 1;
  }
});

// src/worktree-add/start.ts
import path8 from "node:path";
function git3(deps, dir, args) {
  return deps.runner.run({ file: "git", args: ["-C", dir, ...args] });
}
function succeeded3(result) {
  return result.code === 0 && result.spawnError === void 0;
}
async function printed(deps, dir, args) {
  const result = await git3(deps, dir, args);
  const text = result.stdout.trim();
  return succeeded3(result) && text.length > 0 ? text : void 0;
}
async function refExists(deps, dir, ref) {
  return succeeded3(await git3(deps, dir, ["show-ref", "--verify", "--quiet", ref]));
}
async function originHeadBranch(deps, main2) {
  const ref = await printed(deps, main2, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  return ref?.startsWith(ORIGIN_REF_PREFIX) === true ? ref.slice(ORIGIN_REF_PREFIX.length) : void 0;
}
async function defaultBranch(deps, main2) {
  const candidates = [
    await originHeadBranch(deps, main2),
    await printed(deps, main2, ["config", "--get", "init.defaultBranch"]),
    ...FALLBACK_BRANCHES
  ];
  for (const candidate of candidates) {
    if (candidate !== void 0 && candidate.length > 0 && await refExists(deps, main2, `${BRANCH_REF_PREFIX2}${candidate}`)) {
      return candidate;
    }
  }
  return;
}
async function commitOf2(deps, main2, ref) {
  const sha = await printed(deps, main2, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return sha !== void 0 && OBJECT_ID.test(sha) ? sha : void 0;
}
async function upstreamOf(deps, main2, branch) {
  const configured = await printed(deps, main2, [
    "for-each-ref",
    "--format=%(upstream) %(upstream:short)",
    `${BRANCH_REF_PREFIX2}${branch}`
  ]);
  const [ref, shown] = configured?.split(" ") ?? [];
  if (ref !== void 0 && shown !== void 0 && ref.length > 0 && await refExists(deps, main2, ref)) {
    return { ref, shown };
  }
  const remote = `${ORIGIN_REF_PREFIX}${branch}`;
  return await refExists(deps, main2, remote) ? { ref: remote, shown: `origin/${branch}` } : void 0;
}
async function warnIfBehind(deps, main2, branch) {
  const upstream = await upstreamOf(deps, main2, branch);
  if (upstream === void 0) {
    return;
  }
  const count = await printed(deps, main2, ["rev-list", "--count", `${BRANCH_REF_PREFIX2}${branch}..${upstream.ref}`]);
  if (count === void 0 || !COUNT.test(count) || Number.parseInt(count, 10) === 0) {
    return;
  }
  deps.log.warn(
    `local ${showText(branch)} is ${count} commits behind ${showText(upstream.shown)} (local refs, no fetch); the new branch starts from the older commit`
  );
}
async function headStart(deps, main2) {
  const sha = await commitOf2(deps, main2, "HEAD");
  if (sha === void 0) {
    return { ok: false, reason: "the main clone has no commits yet" };
  }
  const branch = await printed(deps, main2, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  deps.log.warn("no default branch found; the new branch starts from the main clone's HEAD");
  return { ok: true, start: { sha, label: branch === void 0 ? "HEAD (detached)" : `HEAD (${branch})` } };
}
async function startPoint(deps, main2) {
  const branch = await defaultBranch(deps, main2);
  if (branch === void 0) {
    return headStart(deps, main2);
  }
  const sha = await commitOf2(deps, main2, `${BRANCH_REF_PREFIX2}${branch}`);
  if (sha === void 0) {
    return { ok: false, reason: `cannot resolve the default branch ${showText(branch)}` };
  }
  await warnIfBehind(deps, main2, branch);
  return { ok: true, start: { sha, label: branch } };
}
async function aheadBehind(deps, main2, base, branch) {
  const counts = await printed(deps, main2, [
    "rev-list",
    "--left-right",
    "--count",
    `${BRANCH_REF_PREFIX2}${base}...${BRANCH_REF_PREFIX2}${branch}`
  ]);
  const match = counts === void 0 ? void 0 : LEFT_RIGHT_COUNTS.exec(counts);
  if (match === null || match === void 0) {
    return;
  }
  const [, behind = "", ahead = ""] = match;
  return `${ahead} ahead / ${behind} behind ${showText(base)}`;
}
async function logExistingBranch(deps, main2, branch) {
  const date = await printed(deps, main2, ["log", "-1", "--format=%cs", `${BRANCH_REF_PREFIX2}${branch}`, "--"]);
  const base = await defaultBranch(deps, main2);
  const counts = base === void 0 ? void 0 : await aheadBehind(deps, main2, base, branch);
  const head = `checking out EXISTING local branch ${showText(branch)}: last commit ${showText(date ?? "unknown")}`;
  deps.log.info(counts === void 0 ? head : `${head}, ${counts}`);
}
function ticketOf(suffix) {
  return TICKET.exec(suffix)?.[1];
}
function namesTicket(folder, key) {
  return folder.includes(`-${key}-`) || folder.endsWith(`-${key}`);
}
function describeEntry(entry) {
  return `${showText(entry.path)} (${entry.branch === void 0 ? "detached" : showText(entry.branch)})`;
}
async function logSameTicket(deps, main2, suffix, target) {
  const key = ticketOf(suffix);
  if (key === void 0) {
    return;
  }
  const entries = await listWorktrees(deps, main2);
  const others = (entries ?? []).filter(
    (entry) => !matchesTarget(entry.path, target) && namesTicket(path8.basename(entry.path), key)
  );
  if (others.length === 0) {
    return;
  }
  deps.log.info(`other worktrees for ticket ${key}: ${others.map((entry) => describeEntry(entry)).join(", ")}`);
}
var BRANCH_REF_PREFIX2, ORIGIN_REF_PREFIX, FALLBACK_BRANCHES, OBJECT_ID, COUNT, LEFT_RIGHT_COUNTS, TICKET;
var init_start = __esm({
  "src/worktree-add/start.ts"() {
    "use strict";
    init_text();
    init_worktrees();
    BRANCH_REF_PREFIX2 = "refs/heads/";
    ORIGIN_REF_PREFIX = "refs/remotes/origin/";
    FALLBACK_BRANCHES = ["main", "master"];
    OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
    COUNT = /^\d+$/u;
    LEFT_RIGHT_COUNTS = /^(\d+)\s+(\d+)$/u;
    TICKET = /^([a-z][a-z0-9]*-\d+)(?:-|$)/u;
  }
});

// src/worktree-add/exclude.ts
import fs8 from "node:fs";
import path9 from "node:path";
function anchoredPattern(rel) {
  const escaped = rel.replaceAll(GLOB_CHARACTERS, String.raw`\$&`);
  return `/${escaped.endsWith(" ") ? `${escaped.slice(0, -1)}${String.raw`\ `}` : escaped}`;
}
function errorCode4(error) {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return;
}
function readExisting(file) {
  try {
    return { ok: true, text: fs8.readFileSync(file, "utf8") };
  } catch (error) {
    return errorCode4(error) === "ENOENT" ? { ok: true, text: "" } : { ok: false };
  }
}
async function excludeFilePath(deps, worktree) {
  const resolved = await deps.runner.run({
    file: "git",
    args: ["-C", worktree, "rev-parse", "--git-path", "info/exclude"]
  });
  const [line = ""] = resolved.stdout.split("\n", 1);
  if (resolved.code !== 0 || line.length === 0) {
    return;
  }
  return path9.resolve(worktree, line);
}
function appendText(text, present, missing) {
  const header = present.has(EXCLUDE_HEADER) ? [] : [EXCLUDE_HEADER];
  const lead = text.length > 0 && !text.endsWith("\n") ? "\n" : "";
  return `${lead}${[...header, ...missing].join("\n")}
`;
}
async function addExcludePatterns(deps, worktree, patterns) {
  if (patterns.length === 0) {
    return;
  }
  const file = await excludeFilePath(deps, worktree);
  if (file === void 0) {
    deps.log.warn(`cannot find the info/exclude file of the repository${FAILURE_TAIL}`);
    return;
  }
  const existing = readExisting(file);
  if (!existing.ok) {
    deps.log.warn(`cannot update ${showText(file)}${FAILURE_TAIL}`);
    return;
  }
  const present = new Set(existing.text.split("\n"));
  const missing = [...new Set(patterns)].filter((pattern) => !present.has(pattern));
  if (missing.length === 0) {
    return;
  }
  try {
    fs8.mkdirSync(path9.dirname(file), { recursive: true });
    fs8.appendFileSync(file, appendText(existing.text, present, missing));
  } catch {
    deps.log.warn(`cannot update ${showText(file)}${FAILURE_TAIL}`);
  }
}
var TEMP_PATTERN, EXCLUDE_HEADER, FAILURE_TAIL, GLOB_CHARACTERS;
var init_exclude = __esm({
  "src/worktree-add/exclude.ts"() {
    "use strict";
    init_text();
    TEMP_PATTERN = ".alex-loop-tmp-*";
    EXCLUDE_HEADER = "# alex-loop worktree-add: links, dependency clones and copy temps in worktrees, ignored in the main clone already";
    FAILURE_TAIL = "; the worktree links show as untracked and must be removed before git worktree remove";
    GLOB_CHARACTERS = /[*?[\\]/gu;
  }
});

// src/worktree-add/sync.ts
import fs9 from "node:fs";
import path10 from "node:path";
function classify(rel) {
  const name = path10.posix.basename(rel);
  if (COPY_NAMES.has(name) || name.startsWith(COPY_PREFIX)) {
    return "copy";
  }
  if (name === DEPENDENCY_NAME) {
    return "dep";
  }
  if (SKIP_NAMES.has(name) || name.endsWith(SKIP_SUFFIX)) {
    return "skip";
  }
  return "link";
}
function errorCode5(error) {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "unknown";
}
async function listIgnored(deps, main2) {
  const listed = await deps.runner.run({
    file: "git",
    args: ["-C", main2, "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]
  });
  if (listed.code !== 0) {
    return;
  }
  return listed.stdout.split("\0").map((entry) => entry.endsWith("/") ? entry.slice(0, -1) : entry).filter((entry) => entry.length > 0);
}
function usableEntries(deps, rels) {
  const kept = [];
  for (const rel of rels) {
    if (hasControlCharacter(rel)) {
      deps.log.warn(`skipped an ignored path with a control character in its name: ${showText(rel)}`);
    } else if (rel.includes(REPLACEMENT_CHARACTER)) {
      deps.log.warn(`skipped an ignored path whose name is not valid UTF-8: ${showText(rel)}`);
    } else {
      kept.push(rel);
    }
  }
  return kept;
}
function isOwnLink(run, rel) {
  return isLinkWithText(path10.join(run.worktree, rel), path10.join(run.main, rel));
}
function destinationOpen(run, rel, kind) {
  if (lstatOrUndefined(path10.join(run.worktree, rel)) === void 0) {
    return true;
  }
  return kind !== "link" && isOwnLink(run, rel);
}
function linkMissing(run, rel) {
  const dest = path10.join(run.worktree, rel);
  if (lstatOrUndefined(dest) !== void 0) {
    return false;
  }
  try {
    fs9.symlinkSync(path10.join(run.main, rel), dest);
    return true;
  } catch (error) {
    const code = errorCode5(error);
    if (code !== "EEXIST") {
      run.deps.log.warn(`cannot link ${showText(rel)} into the worktree: ${showText(code)}`);
    }
    return false;
  }
}
async function syncDependency(run, rel) {
  const outcome = await run.transfer.cloneDependency(rel);
  if (outcome.kind === "cloned") {
    return;
  }
  const linked = linkMissing(run, rel);
  if (outcome.kind === "unavailable") {
    if (linked) {
      run.linkedWithoutCow.push(rel);
    }
    return;
  }
  const fallback = isOwnLink(run, rel) ? "; linked it instead" : "";
  run.deps.log.warn(`cannot clone ${showText(rel)} into the worktree (${showText(outcome.reason)})${fallback}`);
}
async function syncEntry(run, rel, kind) {
  if (kind === "skip" || !parentInside(run.worktree, rel) || !destinationOpen(run, rel, kind)) {
    return;
  }
  switch (kind) {
    case "copy": {
      await run.transfer.copyEntry(rel);
      return;
    }
    case "dep": {
      await syncDependency(run, rel);
      return;
    }
    case "link": {
      if (linkMissing(run, rel)) {
        run.linked.push(rel);
      }
      return;
    }
  }
}
function joinShown(rels) {
  return rels.map((rel) => showText(rel)).join(", ");
}
function reportLinks(run) {
  if (run.linked.length > 0) {
    run.deps.log.info(`linked ${joinShown(run.linked)}`);
  }
  if (run.linkedWithoutCow.length > 0) {
    run.deps.log.info(
      `linked ${joinShown(run.linkedWithoutCow)}: no copy-on-write between the clone and the worktree`
    );
  }
}
function excludedPatterns(run, entries) {
  const patterns = [];
  for (const rel of entries) {
    const kind = classify(rel);
    if (kind === "copy") {
      continue;
    }
    const isDependencyFolder = kind === "dep" && lstatOrUndefined(path10.join(run.worktree, rel))?.isDirectory() === true;
    if (isOwnLink(run, rel) || isDependencyFolder) {
      patterns.push(anchoredPattern(rel));
    }
  }
  return patterns;
}
async function syncIgnored(deps, main2, worktree, transfer) {
  const listed = await listIgnored(deps, main2);
  if (listed === void 0) {
    deps.log.warn(`cannot list the ignored files of ${showText(main2)}; nothing synced into the worktree`);
    return;
  }
  const entries = usableEntries(deps, listed);
  const run = { deps, main: main2, worktree, transfer, linked: [], linkedWithoutCow: [] };
  if (entries.some((rel) => classify(rel) === "copy" || classify(rel) === "dep")) {
    await addExcludePatterns(deps, worktree, [TEMP_PATTERN]);
  }
  for (const rel of entries) {
    await syncEntry(run, rel, classify(rel));
  }
  reportLinks(run);
  await addExcludePatterns(deps, worktree, excludedPatterns(run, entries));
}
var COPY_NAMES, COPY_PREFIX, DEPENDENCY_NAME, SKIP_NAMES, SKIP_SUFFIX, REPLACEMENT_CHARACTER;
var init_sync = __esm({
  "src/worktree-add/sync.ts"() {
    "use strict";
    init_exclude();
    init_paths();
    init_text();
    COPY_NAMES = /* @__PURE__ */ new Set([".env", "CLAUDE.local.md", "temp.local"]);
    COPY_PREFIX = ".env.";
    DEPENDENCY_NAME = "node_modules";
    SKIP_NAMES = /* @__PURE__ */ new Set([
      ".cache",
      ".eslintcache",
      ".next",
      ".turbo",
      "build",
      "coverage",
      "dist",
      "out"
    ]);
    SKIP_SUFFIX = ".tsbuildinfo";
    REPLACEMENT_CHARACTER = "\uFFFD";
  }
});

// src/worktree-add/target.ts
import path11 from "node:path";
function joinedRaw(cwd, parentArg) {
  return path11.isAbsolute(parentArg) ? parentArg : `${cwd}/${parentArg}`;
}
function deriveTarget(suffix, parentArg, cwd, main2) {
  const mainName = path11.basename(main2);
  if (hasControlCharacter(mainName)) {
    return {
      ok: false,
      code: 1,
      message: `the main folder name contains a control character: ${showText(main2)}`
    };
  }
  const parent = canonicalLoose(parentArg === void 0 ? path11.dirname(main2) : joinedRaw(cwd, parentArg));
  const stats = lstatOrUndefined(parent);
  if (stats !== void 0 && !stats.isDirectory()) {
    return {
      ok: false,
      code: 2,
      message: `the parent folder exists but is not a directory: ${showText(parent)}`
    };
  }
  const name = `${mainName}-${suffix}`;
  return {
    ok: true,
    target: {
      suffix,
      name,
      branch: suffix,
      parent,
      parentMissing: stats === void 0,
      path: path11.join(parent, name)
    }
  };
}
var init_target = __esm({
  "src/worktree-add/target.ts"() {
    "use strict";
    init_paths();
    init_text();
  }
});

// src/worktree-add/proc.ts
import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
function errorCode6(error) {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return;
}
function childEnv(...layers) {
  const result = {};
  for (const layer of layers) {
    for (const [name, value] of Object.entries(layer ?? {})) {
      if (value !== void 0) {
        result[name] = value;
      }
    }
  }
  return result;
}
function exitCodeOf(code, signal) {
  if (code !== null) {
    return code;
  }
  if (signal !== null) {
    return 128 + osConstants.signals[signal];
  }
  return 1;
}
function signalGroup(pid, signal) {
  if (pid === void 0) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    return;
  }
}
function groupHasMembers(pid) {
  if (pid === void 0) {
    return false;
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return errorCode6(error) !== "ESRCH";
  }
}
function trySpawn(request, env) {
  try {
    const child = spawn(request.file, [...request.args], {
      cwd: request.cwd,
      env: childEnv(env, request.env),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true
    });
    return { child };
  } catch (error) {
    return { error: errorCode6(error) ?? (error instanceof Error ? error.message : "spawn failed") };
  }
}
function ignoreResult() {
  return;
}
function superviseChild(child, timeoutMs) {
  let resolveResult = ignoreResult;
  const result = new Promise((resolve) => {
    resolveResult = resolve;
  });
  const pid = child.pid;
  const output = { stdout: "", stderr: "" };
  const timers = [];
  let settled = false;
  let cancelled = false;
  let timedOut = false;
  let killStepDone = false;
  let exitCode;
  let closeCode;
  const finish = (value) => {
    if (settled) {
      return;
    }
    settled = true;
    for (const timer of timers) {
      clearTimeout(timer);
    }
    resolveResult(timedOut ? { ...value, timedOut: true } : value);
  };
  const finishWhenQuiet = () => {
    if (closeCode !== void 0 && (killStepDone || !groupHasMembers(pid))) {
      finish({ code: closeCode, ...output });
    }
  };
  const poll = () => {
    finishWhenQuiet();
    if (!settled) {
      timers.push(setTimeout(poll, GROUP_POLL_MS));
    }
  };
  const cancel = () => {
    if (cancelled || settled) {
      return;
    }
    cancelled = true;
    signalGroup(pid, "SIGTERM");
    timers.push(
      setTimeout(() => {
        if (groupHasMembers(pid)) {
          signalGroup(pid, "SIGKILL");
        }
        killStepDone = true;
        finishWhenQuiet();
      }, KILL_GRACE_MS),
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish({ code: closeCode ?? exitCode ?? KILLED_CODE, ...output });
      }, GIVE_UP_MS)
    );
    poll();
  };
  if (timeoutMs !== void 0) {
    timers.push(
      setTimeout(
        () => {
          if (!cancelled && !settled) {
            timedOut = true;
            cancel();
          }
        },
        Math.min(timeoutMs, MAX_TIMER_MS)
      )
    );
  }
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output.stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output.stderr += chunk;
  });
  child.on("error", (error) => {
    finish({ code: SPAWN_FAILED_CODE, ...output, spawnError: errorCode6(error) ?? error.message });
  });
  child.on("exit", (code, signal) => {
    exitCode = exitCodeOf(code, signal);
  });
  child.on("close", (code, signal) => {
    closeCode = exitCodeOf(code, signal);
    if (cancelled) {
      finishWhenQuiet();
    } else {
      finish({ code: closeCode, ...output });
    }
  });
  return { cancel, result };
}
function runCommand(request, env, running) {
  const attempt = trySpawn(request, env);
  if ("error" in attempt) {
    return Promise.resolve({ code: SPAWN_FAILED_CODE, stdout: "", stderr: "", spawnError: attempt.error });
  }
  const supervised = superviseChild(attempt.child, request.timeoutMs);
  running.add(supervised);
  return supervised.result.finally(() => {
    running.delete(supervised);
  });
}
async function terminateRunning(running) {
  const pending = [...running];
  for (const supervised of pending) {
    supervised.cancel();
  }
  await Promise.all(pending.map((supervised) => supervised.result));
}
function createProcessRunner(env) {
  const running = /* @__PURE__ */ new Set();
  return {
    run: (request) => runCommand(request, env, running),
    terminateAll: () => terminateRunning(running)
  };
}
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode6(error) === "EPERM";
  }
}
var SPAWN_FAILED_CODE, KILLED_CODE, KILL_GRACE_MS, GIVE_UP_MS, GROUP_POLL_MS, MAX_TIMER_MS;
var init_proc = __esm({
  "src/worktree-add/proc.ts"() {
    "use strict";
    SPAWN_FAILED_CODE = 127;
    KILLED_CODE = 137;
    KILL_GRACE_MS = 5e3;
    GIVE_UP_MS = 1e4;
    GROUP_POLL_MS = 50;
    MAX_TIMER_MS = 2147483647;
  }
});

// src/worktree-add/transfer.ts
import path12 from "node:path";
function seconds(startedMs, endedMs) {
  return ((endedMs - startedMs) / 1e3).toFixed(1);
}
function place(deps, placement, flags) {
  return placeCopy(deps, { ...placement, ownLinkText: placement.source, cloneFlags: flags });
}
async function copyWithFallback(deps, rel, placement, flags) {
  if (flags !== void 0) {
    const cloned = await place(deps, placement, flags);
    if (cloned.ok) {
      return { ok: true, method: "copy-on-write" };
    }
    deps.log.info(
      `cannot clone ${showText(rel)} with copy-on-write (${showText(cloned.reason)}); copying it instead`
    );
  }
  const copied = await place(deps, placement, NO_FLAGS);
  return copied.ok ? { ok: true, method: "plain copy" } : copied;
}
function createTransfer(deps, options) {
  const { main: main2, worktree, gate } = options;
  const nowMs = options.nowMs ?? (() => Date.now());
  const placementOf = (rel) => ({
    source: path12.join(main2, rel),
    dest: path12.join(worktree, rel)
  });
  const sweep = (placement) => {
    sweepDeadTemps(path12.dirname(placement.dest), pidAlive, deps.pid);
  };
  return {
    async copyEntry(rel) {
      const placement = placementOf(rel);
      sweep(placement);
      const verdict = await gate.check(deps, { main: main2, worktree, rel });
      const flags = verdict.kind === "available" ? cloneFlags(deps.platform) : void 0;
      const startedMs = nowMs();
      const result = await copyWithFallback(deps, rel, placement, flags);
      if (!result.ok) {
        deps.log.warn(`cannot copy ${showText(rel)} into the worktree: ${showText(result.reason)}`);
        return "failed";
      }
      const elapsed = seconds(startedMs, nowMs());
      const sizeKb = String(entrySizeKb(placement.dest));
      deps.log.info(`copied ${showText(rel)} into the worktree: ${sizeKb} KB in ${elapsed} s (${result.method})`);
      return "copied";
    },
    async cloneDependency(rel) {
      const verdict = await gate.check(deps, { main: main2, worktree, rel });
      if (verdict.kind === "unavailable") {
        return verdict;
      }
      const flags = cloneFlags(deps.platform);
      if (flags === void 0) {
        return { kind: "unavailable", reason: UNSUPPORTED_REASON };
      }
      const placement = placementOf(rel);
      sweep(placement);
      deps.log.info(`cloning ${showText(rel)} into the worktree with copy-on-write`);
      const startedMs = nowMs();
      const result = await place(deps, placement, flags);
      if (!result.ok) {
        return { kind: "failed", reason: result.reason };
      }
      deps.log.info(`cloned ${showText(rel)} into the worktree in ${seconds(startedMs, nowMs())} s`);
      return { kind: "cloned" };
    }
  };
}
var NO_FLAGS, UNSUPPORTED_REASON;
var init_transfer = __esm({
  "src/worktree-add/transfer.ts"() {
    "use strict";
    init_cowGate();
    init_place();
    init_proc();
    init_text();
    NO_FLAGS = [];
    UNSUPPORTED_REASON = "copy-on-write clones are not supported on this platform";
  }
});

// src/worktree-add/command.ts
import os from "node:os";
import path13 from "node:path";
function refused(reason) {
  return { kind: "refused", reason };
}
function usage2(message) {
  return { kind: "usage", message };
}
function stayInLinked(deps, repo) {
  const from = repo.mainFound ? `; run it from the main working tree ${showText(repo.main)} to create one` : "";
  deps.log.info(`already in the worktree ${showText(repo.current)}: no new worktree is created${from}`);
  return { kind: "ok", path: repo.current };
}
async function stepFor(deps, repo, target, decision) {
  if (decision.kind === "refuse") {
    return { ok: false, outcome: refused(decision.reason) };
  }
  if (decision.kind === "reuse") {
    return { ok: true, step: decision };
  }
  await logSameTicket(deps, repo.main, target.suffix, target.path);
  switch (decision.kind) {
    case "checkout": {
      await logExistingBranch(deps, repo.main, target.branch);
      return { ok: true, step: decision };
    }
    case "track": {
      return { ok: true, step: decision };
    }
    case "create": {
      const start = await startPoint(deps, repo.main);
      return start.ok ? { ok: true, step: { kind: "create", start: start.start } } : { ok: false, outcome: refused(start.reason) };
    }
  }
}
async function syncQuietly(io, repo, target) {
  const { deps } = io;
  try {
    const transfer = createTransfer(deps, {
      main: repo.main,
      worktree: target.path,
      gate: io.gate ?? createCloneGate()
    });
    await syncIgnored(deps, repo.main, target.path, transfer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.log.warn(`cannot sync ignored paths into the worktree: ${showText(message)}`);
  }
}
async function prepareTarget(io, repo, suffix, parent) {
  const { deps } = io;
  const derived = deriveTarget(suffix, parent, io.cwd, repo.main);
  if (!derived.ok) {
    return { ok: false, outcome: derived.code === 2 ? usage2(derived.message) : refused(derived.message) };
  }
  const { target } = derived;
  deps.log.info(`name based on main clone folder ${showText(path13.basename(repo.main))}`);
  const name = await checkBranchName(deps, repo.current, target.branch);
  if (name === "invalid") {
    return { ok: false, outcome: usage2(`invalid branch name: ${showText(target.branch)}`) };
  }
  if (name !== "valid") {
    return { ok: false, outcome: refused(name.error) };
  }
  return { ok: true, target };
}
async function runWorktreeAdd(io, argv) {
  const { deps } = io;
  const parsed = parseArgs(argv, io.env.HOME ?? os.homedir());
  if (parsed.kind !== "ok") {
    return parsed;
  }
  const versionProblem = await checkGitVersion(deps, io.cwd);
  if (versionProblem !== void 0) {
    return refused(versionProblem);
  }
  const located = await locateRepository(deps, io.cwd);
  if (!located.ok) {
    return refused(located.reason);
  }
  const { repo } = located;
  if (repo.linked) {
    return stayInLinked(deps, repo);
  }
  const prepared = await prepareTarget(io, repo, parsed.suffix, parsed.parent);
  if (!prepared.ok) {
    return prepared.outcome;
  }
  const { target } = prepared;
  const facts = await gatherFacts(deps, repo, target);
  if (!facts.ok) {
    return refused(facts.reason);
  }
  const step = await stepFor(deps, repo, target, decideWorktree(facts.facts));
  if (!step.ok) {
    return step.outcome;
  }
  const applied = await applyStep(deps, repo, target, step.step);
  if (!applied.ok) {
    return refused(applied.reason);
  }
  await syncQuietly(io, repo, target);
  return { kind: "ok", path: target.path };
}
var init_command = __esm({
  "src/worktree-add/command.ts"() {
    "use strict";
    init_args();
    init_cowGate();
    init_create();
    init_decide();
    init_facts();
    init_repo();
    init_start();
    init_sync();
    init_target();
    init_text();
    init_transfer();
    init_versions();
  }
});

// src/worktree-add/temps.ts
import fs10 from "node:fs";
function removeQuietly3(file) {
  try {
    fs10.rmSync(file, { recursive: true, force: true });
  } catch {
    return;
  }
}
function createTempRegistry() {
  const registered = /* @__PURE__ */ new Set();
  return {
    add: (file) => {
      registered.add(file);
    },
    remove: (file) => {
      registered.delete(file);
    },
    removeAll: () => {
      for (const file of registered) {
        removeQuietly3(file);
      }
      registered.clear();
    }
  };
}
var init_temps = __esm({
  "src/worktree-add/temps.ts"() {
    "use strict";
  }
});

// src/worktree-add/main.ts
var main_exports = {};
__export(main_exports, {
  main: () => main
});
import fs11 from "node:fs";
function stoppable(inner) {
  let stopped = false;
  return {
    run: (request) => stopped ? Promise.resolve({ code: STOPPED_CODE, stdout: "", stderr: "", spawnError: "interrupted" }) : inner.run(request),
    terminateAll: () => inner.terminateAll(),
    stop: () => {
      stopped = true;
    },
    stopped: () => stopped
  };
}
function installSignalCleanup(deps, runner) {
  const listeners = /* @__PURE__ */ new Map();
  const uninstall = () => {
    for (const [signal, listener] of listeners) {
      process.removeListener(signal, listener);
    }
    listeners.clear();
  };
  const cleanUp = async (signal) => {
    await runner.terminateAll();
    deps.temps.removeAll();
    uninstall();
    process.kill(process.pid, signal);
  };
  for (const signal of STOP_SIGNALS) {
    const listener = () => {
      if (runner.stopped()) {
        return;
      }
      runner.stop();
      void cleanUp(signal);
    };
    listeners.set(signal, listener);
    process.on(signal, listener);
  }
  return uninstall;
}
function writeStderr(text) {
  fs11.writeSync(2, text);
}
function report(deps, outcome) {
  switch (outcome.kind) {
    case "ok": {
      fs11.writeSync(1, `${outcome.path}
`);
      return 0;
    }
    case "refused": {
      deps.log.error(outcome.reason);
      return 1;
    }
    case "usage": {
      deps.log.error(outcome.message);
      writeStderr(usageText());
      return 2;
    }
    case "help": {
      writeStderr(usageText());
      return 0;
    }
  }
}
async function main(options = {}) {
  const run = options.run ?? runWorktreeAdd;
  const env = process.env;
  const runner = stoppable(createProcessRunner(env));
  const deps = {
    runner,
    log: options.log ?? stderrLogger(),
    temps: createTempRegistry(),
    platform: process.platform,
    pid: process.pid
  };
  const uninstall = installSignalCleanup(deps, runner);
  try {
    const outcome = await run({ deps, env, cwd: process.cwd() }, process.argv.slice(2));
    if (runner.stopped()) {
      return;
    }
    uninstall();
    process.exitCode = report(deps, outcome);
  } catch (error) {
    if (runner.stopped()) {
      return;
    }
    uninstall();
    deps.log.error(showText(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}
var STOP_SIGNALS, STOPPED_CODE;
var init_main = __esm({
  "src/worktree-add/main.ts"() {
    "use strict";
    init_args();
    init_command();
    init_log();
    init_proc();
    init_temps();
    init_text();
    STOP_SIGNALS = ["SIGINT", "SIGTERM"];
    STOPPED_CODE = 1;
  }
});

// src/worktree-add/cli.ts
init_log();
init_versions();
var problem = nodeVersionProblem(process.versions.node);
if (problem === void 0) {
  const { main: main2 } = await Promise.resolve().then(() => (init_main(), main_exports));
  await main2();
} else {
  stderrLogger().error(problem);
  process.exitCode = 1;
}
