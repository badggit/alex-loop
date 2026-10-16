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
function failureLine(result) {
  if (result.spawnError !== void 0) {
    return result.spawnError;
  }
  const [first = ""] = result.stderr.trim().split("\n", 1);
  return first.length > 0 ? first : `git exited with code ${String(result.code)}`;
}
function messageOf(error) {
  try {
    return showText(error instanceof Error ? error.message : String(error));
  } catch {
    return "unknown error";
  }
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
    if (value.startsWith("--")) {
      return usage(`missing value for ${arg}: got the option ${showText(value)}`);
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
function errorCode(error) {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "unknown";
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
function isOwnLink(paths2, rel) {
  return isLinkWithText(path.join(paths2.worktree, rel), path.join(paths2.main, rel));
}
function realOrUndefined(file) {
  try {
    return fs2.realpathSync.native(file);
  } catch {
    return;
  }
}
function missingOrOwnLink(paths2, rel) {
  return lstatOrUndefined(path.join(paths2.worktree, rel)) === void 0 || isOwnLink(paths2, rel);
}
function isAtOrAbove(dir, folder) {
  return dir === "" || folder === dir || folder.startsWith(`${dir}/`);
}
function parentInside(root, rel) {
  const realRoot = realOrUndefined(root);
  const parent = realOrUndefined(path.dirname(path.join(root, rel)));
  return realRoot !== void 0 && parent === path.join(realRoot, path.dirname(rel));
}
function parentExists(root, rel) {
  return realOrUndefined(path.dirname(path.join(root, rel))) !== void 0;
}
var JS_DEPS, UV_VENV;
var init_paths = __esm({
  "src/worktree-add/paths.ts"() {
    "use strict";
    JS_DEPS = "node_modules";
    UV_VENV = ".venv";
  }
});

// src/worktree-add/place.ts
import fs3 from "node:fs";
import path2 from "node:path";
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
    return errorCode(error) === "ENOENT" ? "unlocked" : "unknown";
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
function git2(deps, dir, args) {
  return deps.runner.run({ file: "git", args: ["-C", dir, ...args] });
}
function succeeded2(result) {
  return result.code === 0 && result.spawnError === void 0;
}
function failureLine2(result) {
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
    return errorCode(error) === "ENOENT" ? "absent" : "unreadable";
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
  return { ok: false, reason: `cannot check ${kind} ${showText(ref)}: ${showText(failureLine2(result))}` };
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

// src/worktree-add/assign.ts
function splitRel(rel) {
  const slash = rel.lastIndexOf("/");
  return slash === -1 ? { parent: "", name: rel } : { parent: rel.slice(0, slash), name: rel.slice(slash + 1) };
}
function nearestOwner(projects, ecosystem, folder) {
  let best;
  for (const [index, project] of projects.entries()) {
    if (project.ecosystem !== ecosystem || !isAtOrAbove(project.dir, folder)) {
      continue;
    }
    const current = best === void 0 ? void 0 : projects[best];
    if (current === void 0 || project.dir.length > current.dir.length) {
      best = index;
    }
  }
  return best;
}
function assignDependencies(projects, depRels, isMember2) {
  const installs = projects.map(() => []);
  const links = projects.map(() => []);
  const orphans = [];
  for (const rel of depRels) {
    const { parent, name } = splitRel(rel);
    const ecosystem = name === JS_DEPS ? "js" : "uv";
    const owner = nearestOwner(projects, ecosystem, parent);
    const project = owner === void 0 ? void 0 : projects[owner];
    if (owner === void 0 || project === void 0 || ecosystem === "js" && parent !== project.dir && !isMember2(project, parent)) {
      orphans.push(rel);
      continue;
    }
    const installed = ecosystem === "js" || name === UV_VENV && parent === project.dir;
    (installed ? installs : links)[owner]?.push(rel);
  }
  const assigned = projects.map((project, index) => {
    const ownDeps = installs[index] ?? [];
    const ownLinks = links[index] ?? [];
    return {
      ...project,
      depRels: ownDeps,
      linkOnly: ownLinks,
      auto: project.dir === "" || ownDeps.length > 0 || ownLinks.length > 0
    };
  });
  return { projects: assigned, orphans };
}
var init_assign = __esm({
  "src/worktree-add/assign.ts"() {
    "use strict";
    init_paths();
  }
});

// src/worktree-add/proc.ts
import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
function codeOrUndefined(error) {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return;
}
function childEnv(runnerEnv, requestEnv) {
  const result = /* @__PURE__ */ new Map();
  for (const [name, value] of Object.entries(runnerEnv)) {
    if (value !== void 0) {
      result.set(name, value);
    }
  }
  for (const [name, value] of Object.entries(requestEnv ?? {})) {
    if (value === void 0) {
      result.delete(name);
    } else {
      result.set(name, value);
    }
  }
  return Object.fromEntries(result);
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
    return codeOrUndefined(error) !== "ESRCH";
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
    return { error: codeOrUndefined(error) ?? (error instanceof Error ? error.message : "spawn failed") };
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
          if (cancelled || settled) {
            return;
          }
          if (exitCode === void 0) {
            timedOut = true;
          }
          cancel();
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
    finish({ code: SPAWN_FAILED_CODE, ...output, spawnError: codeOrUndefined(error) ?? error.message });
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
    return codeOrUndefined(error) === "EPERM";
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

// src/worktree-add/managers.ts
import fs8 from "node:fs";
import path7 from "node:path";
function executableOf(manager) {
  return EXECUTABLES[manager];
}
function isJsFamily(name) {
  return Object.hasOwn(FAMILY_LOCKS, name);
}
function readHead(file) {
  let fd;
  try {
    fd = fs8.openSync(file, "r");
    const buffer = Buffer.alloc(HEAD_BYTES);
    const size = fs8.readSync(fd, buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, size).toString("utf8");
  } catch {
    return;
  } finally {
    if (fd !== void 0) {
      fs8.closeSync(fd);
    }
  }
}
function readPackageManagerField(projectDir) {
  let parsed;
  try {
    parsed = JSON.parse(fs8.readFileSync(path7.join(projectDir, "package.json"), "utf8"));
  } catch {
    return { kind: "absent" };
  }
  if (typeof parsed !== "object" || !parsed || !("packageManager" in parsed)) {
    return { kind: "absent" };
  }
  const value = parsed.packageManager;
  if (typeof value !== "string") {
    return { kind: "absent" };
  }
  const spec = value.trim();
  const match = /^([a-z]+)@(\d+)\.\d+\.\d+(?:[-+].*)?$/.exec(spec);
  const name = match?.[1];
  const major = match?.[2];
  if (name === void 0 || major === void 0 || !isJsFamily(name)) {
    return { kind: "invalid", text: value };
  }
  return { kind: "pinned", pin: { family: name, major: Number(major), spec } };
}
function exactMajor(name, major) {
  return { text: `${name} ${major}`, accepts: (found) => found === major };
}
function yarnKind(projectDir) {
  const head = readHead(path7.join(projectDir, "yarn.lock")) ?? "";
  if (/^__metadata:/m.test(head)) {
    return "yarn-berry";
  }
  if (/^# yarn lockfile v1\s*$/m.test(head)) {
    return "yarn-classic";
  }
  return;
}
function yarnPathMajor(projectDir) {
  const rc = readHead(path7.join(projectDir, ".yarnrc.yml")) ?? "";
  const match = /^yarnPath:\s*["']?([^"'\n#]*?)["']?\s*(?:#.*)?$/m.exec(rc);
  const release = /(?:^|\/)yarn-(\d+)\.\d+\.\d+\.cjs$/.exec(match?.[1] ?? "");
  return release?.[1] === void 0 ? void 0 : Number(release[1]);
}
function berryExpectation(projectDir) {
  const pinned = yarnPathMajor(projectDir);
  if (pinned !== void 0) {
    return exactMajor("yarn", pinned);
  }
  return { text: "yarn 2 or newer", accepts: (major) => major >= 2 };
}
function pnpmExpectation(projectDir) {
  const head = readHead(path7.join(projectDir, "pnpm-lock.yaml")) ?? "";
  const match = /^lockfileVersion:\s*["']?(\d+)(?:\.\d+)?["']?\s*$/m.exec(head);
  const majors = match?.[1] === void 0 ? void 0 : PNPM_LOCK_MAJORS.get(Number(match[1]));
  if (majors === void 0) {
    return;
  }
  return { text: `pnpm ${majors.join(" or ")}`, accepts: (major) => majors.includes(major) };
}
function fromLock(projectDir, family) {
  switch (family) {
    case "npm":
    case "bun": {
      return { kind: "manager", manager: family, expected: void 0 };
    }
    case "pnpm": {
      return { kind: "manager", manager: "pnpm", expected: pnpmExpectation(projectDir) };
    }
    case "yarn": {
      const kind = yarnKind(projectDir);
      if (kind === void 0) {
        return {
          kind: "conflict",
          reason: 'yarn.lock has neither a "# yarn lockfile v1" header nor a __metadata: section'
        };
      }
      const expected = kind === "yarn-berry" ? berryExpectation(projectDir) : exactMajor("yarn", 1);
      return { kind: "manager", manager: kind, expected };
    }
  }
}
function pinLockMismatch(projectDir, pin) {
  const shownPin = pin.spec.replace(/\+.*$/, "");
  if (pin.family === "yarn") {
    const kind = yarnKind(projectDir);
    if (kind === "yarn-berry" && pin.major === 1) {
      return `packageManager names ${shownPin} but yarn.lock is a yarn 2 or newer (berry) lock file`;
    }
    if (kind === "yarn-classic" && pin.major !== 1) {
      return `packageManager names ${shownPin} but yarn.lock is a yarn 1 lock file`;
    }
    return;
  }
  if (pin.family === "pnpm") {
    const allowed = pnpmExpectation(projectDir);
    if (allowed !== void 0 && !allowed.accepts(pin.major)) {
      return `packageManager names ${shownPin} but pnpm-lock.yaml is written by ${allowed.text}`;
    }
  }
  return;
}
function fromPin(projectDir, pin, lockNames) {
  const own = FAMILY_LOCKS[pin.family];
  if (!lockNames.some((name) => own.includes(name))) {
    return {
      kind: "conflict",
      reason: `packageManager names ${pin.family} ${pin.major} but ${own.join(" / ")} is missing (found ${lockNames.join(", ")})`
    };
  }
  const mismatch = pinLockMismatch(projectDir, pin);
  if (mismatch !== void 0) {
    return { kind: "conflict", reason: mismatch };
  }
  const { family } = pin;
  let manager;
  if (family === "yarn") {
    manager = pin.major === 1 ? "yarn-classic" : "yarn-berry";
  } else {
    manager = family;
  }
  const expected = exactMajor(pin.family, pin.major);
  return { kind: "manager", manager, expected: family === "npm" ? { ...expected, advisory: true } : expected };
}
function chooseManager(projectDir, ecosystem, lockNames) {
  if (ecosystem === "uv") {
    return { kind: "manager", manager: "uv", expected: void 0 };
  }
  const field = readPackageManagerField(projectDir);
  if (field.kind === "invalid") {
    return {
      kind: "conflict",
      reason: `package.json packageManager "${field.text}" is not a supported NAME@X.Y.Z`
    };
  }
  if (field.kind === "pinned") {
    return fromPin(projectDir, field.pin, lockNames);
  }
  const jsLocks = lockNames.filter((name) => LOCK_FAMILIES.has(name));
  const families = new Set(jsLocks.map((name) => LOCK_FAMILIES.get(name)));
  const [family, ...others] = families;
  if (family === void 0) {
    return { kind: "conflict", reason: "no JS lock file was found" };
  }
  if (others.length > 0) {
    return {
      kind: "conflict",
      reason: `several package managers' lock files (${jsLocks.join(", ")}) and no packageManager in package.json`
    };
  }
  return fromLock(projectDir, family);
}
function failureReason(result, timeoutMs) {
  if (result.timedOut === true) {
    return `--version timed out after ${timeoutMs} ms`;
  }
  if (result.spawnError !== void 0) {
    return `could not start: ${result.spawnError}`;
  }
  const detail = (result.stderr.trim() || result.stdout.trim()).split("\n", 1)[0] ?? "";
  return `--version exited with code ${result.code}${detail ? `: ${detail}` : ""}`;
}
async function checkManagerVersion(deps, manager, expected, projectDir, timeoutMs = VERSION_TIMEOUT_MS) {
  const result = await deps.runner.run({
    file: executableOf(manager),
    args: ["--version"],
    cwd: projectDir,
    timeoutMs
  });
  if (result.code === SPAWN_FAILED_CODE && result.spawnError === "ENOENT") {
    return { kind: "missing" };
  }
  const expectedText = expected?.text ?? `${executableOf(manager)} (any version)`;
  if (result.code !== 0 || result.timedOut === true) {
    return { kind: "mismatch", expected: expectedText, found: `unknown (${failureReason(result, timeoutMs)})` };
  }
  const match = /(\d+)\.\d+(?:\.\d+)?/.exec(result.stdout);
  const version = match?.[0];
  const major = match?.[1];
  if (version === void 0 || major === void 0) {
    return { kind: "mismatch", expected: expectedText, found: "unknown (no version in --version output)" };
  }
  if (expected !== void 0 && !expected.accepts(Number(major))) {
    return { kind: expected.advisory === true ? "differs" : "mismatch", expected: expected.text, found: version };
  }
  return { kind: "ok", version };
}
var VERSION_TIMEOUT_MS, HEAD_BYTES, LOCK_FAMILIES, FAMILY_LOCKS, EXECUTABLES, PNPM_LOCK_MAJORS;
var init_managers = __esm({
  "src/worktree-add/managers.ts"() {
    "use strict";
    init_proc();
    VERSION_TIMEOUT_MS = 2e4;
    HEAD_BYTES = 64 * 1024;
    LOCK_FAMILIES = /* @__PURE__ */ new Map([
      ["package-lock.json", "npm"],
      ["npm-shrinkwrap.json", "npm"],
      ["pnpm-lock.yaml", "pnpm"],
      ["yarn.lock", "yarn"],
      ["bun.lock", "bun"],
      ["bun.lockb", "bun"]
    ]);
    FAMILY_LOCKS = {
      npm: ["package-lock.json", "npm-shrinkwrap.json"],
      pnpm: ["pnpm-lock.yaml"],
      yarn: ["yarn.lock"],
      bun: ["bun.lock", "bun.lockb"]
    };
    EXECUTABLES = {
      npm: "npm",
      pnpm: "pnpm",
      "yarn-classic": "yarn",
      "yarn-berry": "yarn",
      bun: "bun",
      uv: "uv"
    };
    PNPM_LOCK_MAJORS = /* @__PURE__ */ new Map([
      [9, [9, 10]],
      [6, [8]],
      [5, [6, 7]]
    ]);
  }
});

// src/worktree-add/attempt.ts
import fs9 from "node:fs";
function uvEnv(timeoutMs) {
  const seconds2 = Math.max(1, Math.ceil(timeoutMs / 1e3));
  return {
    UV_HTTP_TIMEOUT: String(seconds2),
    UV_HTTP_RETRIES: "1",
    UV_HTTP_CONNECT_TIMEOUT: String(Math.max(1, Math.floor(seconds2 / 3)))
  };
}
function installCommand(manager) {
  return COMMANDS[manager].shown;
}
function combined(result) {
  return result.stdout + result.stderr;
}
function readLock(file) {
  try {
    return { kind: "bytes", bytes: fs9.readFileSync(file) };
  } catch (error) {
    return errorCode(error) === "ENOENT" ? { kind: "absent" } : { kind: "unreadable", reason: messageOf(error) };
  }
}
function readLocks(files) {
  return new Map(files.map((file) => [file, readLock(file)]));
}
function sameLock(before, after) {
  if (before.kind === "bytes" && after.kind === "bytes") {
    return before.bytes.equals(after.bytes);
  }
  return before.kind === "absent" && after.kind === "absent";
}
function restoreLocks(snapshot) {
  let changed = false;
  const problems = [];
  for (const [file, before] of snapshot) {
    if (before.kind === "unreadable") {
      problems.push(`${file}: could not be read before the install, left as it is: ${before.reason}`);
      continue;
    }
    if (sameLock(before, readLock(file))) {
      continue;
    }
    changed = true;
    try {
      if (before.kind === "absent") {
        fs9.rmSync(file, { force: true });
      } else {
        fs9.writeFileSync(file, before.bytes);
      }
    } catch (error) {
      problems.push(`${file}: ${messageOf(error)}`);
    }
  }
  return problems.length === 0 ? { changed } : { changed, problem: problems.join("; ") };
}
function attemptsOf(commands, networkTimeoutMs) {
  const online = {
    args: commands.online(networkTimeoutMs),
    env: { ...commands.env, ...commands.onlineEnv(networkTimeoutMs) }
  };
  const offline = commands.offline === void 0 ? void 0 : { args: commands.offline, env: commands.env };
  return offline === void 0 ? { online } : { offline, online };
}
function showsOfflineMiss(commands, result) {
  const text = combined(result);
  return commands.offlineMissSignals.some((signal) => text.includes(signal));
}
async function runWithProgress(deps, request, attempt, firstStartMs) {
  const timer = setInterval(() => {
    const seconds2 = Math.floor((request.nowMs() - firstStartMs) / 1e3);
    deps.log.info(`still installing with ${request.label} (${seconds2} s)`);
  }, request.progressMs);
  try {
    return await deps.runner.run({
      file: executableOf(request.manager),
      args: attempt.args,
      cwd: request.projectDir,
      env: attempt.env,
      timeoutMs: Math.max(0, request.deadlineMs - request.nowMs())
    });
  } finally {
    clearInterval(timer);
  }
}
function noTimeLeft(request) {
  return request.deadlineMs - request.nowMs() <= 0;
}
async function runInstall(deps, request) {
  const commands = COMMANDS[request.manager];
  const attempts = attemptsOf(commands, request.networkTimeoutMs);
  const locks = readLocks(request.lockFiles);
  const startedMs = request.nowMs();
  let output = "";
  let last;
  let online = false;
  let skippedForTime = false;
  if (attempts.offline !== void 0) {
    if (noTimeLeft(request)) {
      skippedForTime = true;
    } else {
      last = await runWithProgress(deps, request, attempts.offline, startedMs);
      output += combined(last);
    }
  }
  const wantsOnline = last === void 0 ? !skippedForTime : last.code !== 0 && !last.timedOut && showsOfflineMiss(commands, last);
  if (wantsOnline) {
    if (noTimeLeft(request)) {
      skippedForTime = true;
    } else {
      online = true;
      last = await runWithProgress(deps, request, attempts.online, startedMs);
      output += combined(last);
    }
  }
  const lockCheck = restoreLocks(locks);
  const timedOut = skippedForTime || last?.timedOut === true;
  const code = last?.code ?? 1;
  return {
    ok: code === 0 && !timedOut && !lockCheck.changed && lockCheck.problem === void 0,
    output,
    code,
    timedOut,
    spawnError: last?.spawnError,
    lockChanged: lockCheck.changed,
    lockRestoreProblem: lockCheck.problem,
    elapsedMs: request.nowMs() - startedMs,
    online,
    lastOutput: last === void 0 ? "" : combined(last)
  };
}
var NPM_STYLE_FETCH_LIMITS, NO_ENV, UV_OWN_ENV, COMMANDS;
var init_attempt = __esm({
  "src/worktree-add/attempt.ts"() {
    "use strict";
    init_managers();
    init_paths();
    init_text();
    NPM_STYLE_FETCH_LIMITS = (timeoutMs) => [
      `--fetch-timeout=${timeoutMs}`,
      "--fetch-retries=1",
      "--fetch-retry-mintimeout=2000",
      "--fetch-retry-maxtimeout=10000"
    ];
    NO_ENV = () => ({});
    UV_OWN_ENV = { UV_PROJECT_ENVIRONMENT: void 0, VIRTUAL_ENV: void 0 };
    COMMANDS = {
      npm: {
        shown: "npm ci",
        offline: ["ci", "--offline"],
        offlineMissSignals: ["ENOTCACHED"],
        online: (timeoutMs) => ["ci", ...NPM_STYLE_FETCH_LIMITS(timeoutMs)],
        env: {},
        onlineEnv: NO_ENV
      },
      pnpm: {
        shown: "pnpm install --frozen-lockfile",
        offline: ["install", "--frozen-lockfile", "--offline"],
        offlineMissSignals: ["ERR_PNPM_NO_OFFLINE_TARBALL", "ERR_PNPM_NO_OFFLINE_META"],
        online: (timeoutMs) => ["install", "--frozen-lockfile", ...NPM_STYLE_FETCH_LIMITS(timeoutMs)],
        env: {},
        onlineEnv: NO_ENV
      },
      "yarn-classic": {
        shown: "yarn install --frozen-lockfile",
        offline: ["install", "--frozen-lockfile", "--offline"],
        offlineMissSignals: ["Couldn't find any versions", "Can't make a request in offline mode"],
        online: (timeoutMs) => ["install", "--frozen-lockfile", "--network-timeout", String(timeoutMs)],
        env: {},
        onlineEnv: NO_ENV
      },
      "yarn-berry": {
        shown: "yarn install --immutable",
        offline: void 0,
        offlineMissSignals: [],
        online: () => ["install", "--immutable"],
        env: {},
        onlineEnv: (timeoutMs) => ({ YARN_HTTP_TIMEOUT: String(timeoutMs), YARN_HTTP_RETRY: "1" })
      },
      bun: {
        shown: "bun install --frozen-lockfile",
        offline: void 0,
        offlineMissSignals: [],
        online: () => ["install", "--frozen-lockfile"],
        env: {},
        onlineEnv: NO_ENV
      },
      uv: {
        shown: "uv sync --frozen",
        offline: ["sync", "--frozen", "--offline"],
        // The last one is uv's hint when the project's Python must be downloaded, which offline mode forbids.
        offlineMissSignals: ["not found in the cache", "Network connectivity is disabled", "uv is set to offline mode"],
        online: () => ["sync", "--frozen"],
        env: UV_OWN_ENV,
        onlineEnv: uvEnv
      }
    };
  }
});

// src/worktree-add/mask.ts
function secretEnvValues(env) {
  const values = [];
  for (const [name, value] of Object.entries(env)) {
    if (value !== void 0 && value.length >= MIN_SECRET_LENGTH && SECRET_NAME.test(name)) {
      values.push(value);
    }
  }
  return values.toSorted((left, right) => right.length - left.length);
}
function maskUrlCredentials(_match, scheme, user, password) {
  return password === void 0 ? `${scheme}${MASK}@` : `${scheme}${user}:${MASK}@`;
}
function maskSecrets(text, env) {
  let masked = text;
  for (const value of secretEnvValues(env)) {
    masked = masked.replaceAll(value, MASK);
  }
  return masked.replaceAll(URL_CREDENTIALS, maskUrlCredentials).replaceAll(AUTH_SETTING, `$1$2${MASK}`);
}
var MASK, MIN_SECRET_LENGTH, SECRET_NAME, URL_CREDENTIALS, AUTH_SETTING;
var init_mask = __esm({
  "src/worktree-add/mask.ts"() {
    "use strict";
    MASK = "***";
    MIN_SECRET_LENGTH = 8;
    SECRET_NAME = /TOKEN|SECRET|PASSWORD|AUTH|KEY/iu;
    URL_CREDENTIALS = /\b([a-z][\d+.a-z-]*:\/\/)([^\s/:@]*)(:[^\s/@]+)?@/giu;
    AUTH_SETTING = /\b(_authToken|_auth|_password|npmAuthToken|npmAuthIdent)(\s*[:=]\s*)["']?[^\s"',]+["']?/giu;
  }
});

// src/worktree-add/configGuard.ts
import path8 from "node:path";
function configGit(deps, file, args) {
  return deps.runner.run({ file: "git", args: ["config", "--file", file, ...args] });
}
function parseList(stdout) {
  const entries = /* @__PURE__ */ new Map();
  for (const record of stdout.split("\0")) {
    if (record.length === 0) {
      continue;
    }
    const at = record.indexOf("\n");
    const key = at === -1 ? record : record.slice(0, at);
    const value = at === -1 ? "true" : record.slice(at + 1);
    const values = entries.get(key);
    if (values === void 0) {
      entries.set(key, [value]);
    } else {
      values.push(value);
    }
  }
  return entries;
}
async function readConfig(deps, file) {
  const result = await configGit(deps, file, ["--list", "-z"]);
  if (result.code !== 0) {
    return { ok: false, reason: failureLine(result) };
  }
  return { ok: true, entries: parseList(result.stdout) };
}
function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function shownValues(key, values, env) {
  if (values.length === 0) {
    return UNSET;
  }
  if (SENSITIVE_KEY.test(key)) {
    return values.map(() => HIDDEN).join(", ");
  }
  return showText(maskSecrets(values.join(", "), env));
}
async function currentValues(deps, env, file, key) {
  const read = await readConfig(deps, file);
  return read.ok ? shownValues(key, read.entries.get(key) ?? [], env) : UNKNOWN;
}
function isConcurrentKey(key) {
  const [section = ""] = key.split(".", 1);
  return CONCURRENT_SECTIONS.has(section.toLowerCase());
}
async function snapshotSharedConfig(deps, worktree) {
  const result = await deps.runner.run({ file: "git", args: ["-C", worktree, "rev-parse", "--git-common-dir"] });
  const printed2 = result.stdout.trim();
  if (result.code !== 0 || printed2.length === 0) {
    return;
  }
  const file = path8.join(path8.resolve(worktree, printed2), "config");
  const read = await readConfig(deps, file);
  return read.ok ? { file, entries: read.entries } : void 0;
}
async function restoreKey(deps, file, key, values) {
  const unset = await configGit(deps, file, ["--unset-all", key]);
  if (unset.code !== 0 && unset.code !== KEY_ABSENT_CODE) {
    return failureLine(unset);
  }
  for (const value of values) {
    const added = await configGit(deps, file, ["--add", key, value]);
    if (added.code !== 0) {
      return failureLine(added);
    }
  }
  return;
}
async function revertConfigChanges(deps, env, snapshot) {
  const file = showText(snapshot.file);
  const read = await readConfig(deps, snapshot.file);
  if (!read.ok) {
    const reason = showText(maskSecrets(read.reason, env));
    deps.log.warn(`cannot check the shared repository config ${file} after the install: ${reason}`);
    return [];
  }
  const keys = /* @__PURE__ */ new Set([...snapshot.entries.keys(), ...read.entries.keys()]);
  const reverted = [];
  for (const key of keys) {
    const before = snapshot.entries.get(key) ?? [];
    const after = read.entries.get(key) ?? [];
    if (isConcurrentKey(key) || sameValues(before, after)) {
      continue;
    }
    const shownKey = showText(maskSecrets(key, env));
    const failure = await restoreKey(deps, snapshot.file, key, before);
    if (failure === void 0) {
      reverted.push(key);
      deps.log.warn(
        `reverted ${shownKey} in the shared repository config: an install changed it from ${shownValues(key, before, env)} to ${shownValues(key, after, env)}; set it by hand if the branch needs it`
      );
    } else {
      const reason = showText(maskSecrets(failure, env));
      const stays = await currentValues(deps, env, snapshot.file, key);
      deps.log.warn(`cannot revert ${shownKey} in ${file}: ${reason}; it stays ${stays}`);
    }
  }
  return reverted;
}
var KEY_ABSENT_CODE, UNSET, UNKNOWN, HIDDEN, SENSITIVE_KEY, CONCURRENT_SECTIONS;
var init_configGuard = __esm({
  "src/worktree-add/configGuard.ts"() {
    "use strict";
    init_mask();
    init_text();
    KEY_ABSENT_CODE = 5;
    UNSET = "(unset)";
    UNKNOWN = "(unknown)";
    HIDDEN = "***";
    SENSITIVE_KEY = /extraheader|password|passwd|token|secret|cookie|credential|auth/iu;
    CONCURRENT_SECTIONS = /* @__PURE__ */ new Set(["branch", "remote"]);
  }
});

// src/worktree-add/deadline.ts
function createDeadline(startedMs, phaseMs, nowMs) {
  const phaseEndMs = startedMs + phaseMs;
  const remainingMs = () => Math.max(0, phaseEndMs - nowMs());
  return {
    phaseEndMs,
    remainingMs,
    shareMs: (projectsLeft) => Math.floor(remainingMs() / Math.max(1, projectsLeft))
  };
}
var INSTALL_PHASE_MS, MIN_START_MS;
var init_deadline = __esm({
  "src/worktree-add/deadline.ts"() {
    "use strict";
    INSTALL_PHASE_MS = 45e4;
    MIN_START_MS = 5e3;
  }
});

// src/worktree-add/discover.ts
import fs10 from "node:fs";
import path9 from "node:path";
function patternSegments(pattern) {
  let text = pattern.trim();
  while (text.startsWith("./")) {
    text = text.slice(2);
  }
  return text.split("/").filter((segment) => segment.length > 0 && segment !== ".");
}
function literalSource(char) {
  return /[$()*+.?[\\\]^{|}]/u.test(char) ? `\\${char}` : char;
}
function classEnd(pattern, open) {
  let start = open + 1;
  if (pattern[start] === "!" || pattern[start] === "^") {
    start += 1;
  }
  return pattern.indexOf("]", start + 1);
}
function classSource(body) {
  const negated = body.startsWith("!") || body.startsWith("^");
  const members = (negated ? body.slice(1) : body).replaceAll(/[[\\\]^]/gu, String.raw`\$&`);
  return negated ? `[^/${members}]` : `[${members}]`;
}
function braceEnd(pattern, open) {
  const close = pattern.indexOf("}", open + 1);
  const body = pattern.slice(open + 1, close);
  return close !== -1 && body.includes(",") && !body.includes("{") ? close : -1;
}
function globSource(pattern) {
  let source = "";
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index] ?? "";
    const classClose = char === "[" ? classEnd(pattern, index) : -1;
    const braceClose = char === "{" ? braceEnd(pattern, index) : -1;
    if (classClose >= 0) {
      source += classSource(pattern.slice(index + 1, classClose));
      index = classClose + 1;
      continue;
    }
    if (braceClose >= 0) {
      const options = pattern.slice(index + 1, braceClose).split(",");
      source += `(?:${options.map((option) => globSource(option)).join("|")})`;
      index = braceClose + 1;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += literalSource(char);
    }
    index += 1;
  }
  return source;
}
function segmentMatches(pattern, segment) {
  try {
    return new RegExp(`^${globSource(pattern)}$`, "u").test(segment);
  } catch {
    return false;
  }
}
function segmentsMatch(pattern, pi, rel, ri) {
  const head = pattern[pi];
  if (head === void 0) {
    return ri === rel.length;
  }
  if (head === "**" && pi === pattern.length - 1) {
    return ri < rel.length;
  }
  if (head === "**") {
    return segmentsMatch(pattern, pi + 1, rel, ri) || ri < rel.length && segmentsMatch(pattern, pi, rel, ri + 1);
  }
  const segment = rel[ri];
  return segment !== void 0 && segmentMatches(head, segment) && segmentsMatch(pattern, pi + 1, rel, ri + 1);
}
function matchesWorkspaceGlob(pattern, rel) {
  return segmentsMatch(patternSegments(pattern), 0, patternSegments(rel), 0);
}
function readText(file) {
  try {
    return fs10.readFileSync(file, "utf8");
  } catch {
    return void 0;
  }
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringsOf(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : void 0;
}
function withoutComment(line) {
  let quote;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote !== void 0) {
      if (char === quote) {
        quote = void 0;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "#" && (index === 0 || /\s/u.test(line[index - 1] ?? ""))) {
      return line.slice(0, index);
    }
  }
  return line;
}
function unquoted(text) {
  const value = text.trim();
  const first = value[0];
  if (value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first)) {
    return value.slice(1, -1);
  }
  return value;
}
function flowItems(text) {
  const inner = text.trim().replace(/^\[/u, "").replace(/\]$/u, "");
  return inner.split(",").map((item) => unquoted(item)).filter((item) => item.length > 0);
}
function yamlPackages(text) {
  const lines = text.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^packages\s*:/u.test(line));
  if (start === -1) {
    return void 0;
  }
  const rest = withoutComment(lines[start] ?? "").replace(/^packages\s*:/u, "").trim();
  if (rest.startsWith("[")) {
    let flow = rest;
    for (let index = start + 1; !flow.includes("]") && index < lines.length; index += 1) {
      flow += ` ${withoutComment(lines[index] ?? "")}`;
    }
    return flowItems(flow);
  }
  if (rest.length > 0) {
    return void 0;
  }
  const items = [];
  for (const raw of lines.slice(start + 1)) {
    const line = withoutComment(raw);
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (!trimmed.startsWith("-")) {
      break;
    }
    const item = unquoted(trimmed.slice(1));
    if (item.length > 0) {
      items.push(item);
    }
  }
  return items;
}
function quotedStrings(text) {
  return [...text.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/gu)].map((match) => match[1] ?? match[2] ?? "");
}
function tomlWorkspaceArrays(text) {
  const arrays = /* @__PURE__ */ new Map();
  const lines = text.split(/\r?\n/u);
  let inTable = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = withoutComment(lines[index] ?? "");
    const header = /^\s*\[\[?([^\]]*)\]\]?\s*$/u.exec(line);
    if (header !== null) {
      inTable = (header[1] ?? "").replaceAll(/\s/gu, "") === UV_WORKSPACE_TABLE;
      continue;
    }
    const entry = /^\s*([\w-]+)\s*=\s*(\[.*)$/u.exec(line);
    if (!inTable || entry === null) {
      continue;
    }
    let value = entry[2] ?? "";
    while (!value.replaceAll(/"(?:[^"\\]|\\.)*"|'[^']*'/gu, "").includes("]") && index + 1 < lines.length) {
      index += 1;
      value += ` ${withoutComment(lines[index] ?? "")}`;
    }
    arrays.set(entry[1] ?? "", quotedStrings(value));
  }
  return arrays;
}
function packageJsonWorkspaces(file) {
  const text = readText(file);
  if (text === void 0) {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) {
    return [];
  }
  const workspaces = parsed.workspaces;
  return stringsOf(workspaces) ?? (isRecord(workspaces) ? stringsOf(workspaces.packages) ?? [] : []);
}
function jsWorkspace(dir) {
  const yaml = readText(path9.join(dir, "pnpm-workspace.yaml"));
  const patterns = [
    ...packageJsonWorkspaces(path9.join(dir, "package.json")),
    ...(yaml === void 0 ? void 0 : yamlPackages(yaml)) ?? []
  ];
  const include = patterns.filter((pattern) => !pattern.startsWith("!"));
  const exclude = patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
  return include.length > 0 ? { include, exclude } : void 0;
}
function uvWorkspace(dir) {
  const text = readText(path9.join(dir, "pyproject.toml"));
  if (text === void 0) {
    return void 0;
  }
  const arrays = tomlWorkspaceArrays(text);
  const include = arrays.get("members") ?? [];
  return include.length > 0 ? { include, exclude: arrays.get("exclude") ?? [] } : void 0;
}
function specKey(project) {
  return `${project.ecosystem}\0${project.dir}`;
}
function workspaceOf(worktree, project, specs) {
  const key = specKey(project);
  if (specs.has(key)) {
    return specs.get(key);
  }
  const dir = path9.join(worktree, project.dir);
  const spec = project.ecosystem === "js" ? jsWorkspace(dir) : uvWorkspace(dir);
  specs.set(key, spec);
  return spec;
}
function relativeBelow(ancestor, dir) {
  if (ancestor === "") {
    return dir === "" ? void 0 : dir;
  }
  return dir.startsWith(`${ancestor}/`) ? dir.slice(ancestor.length + 1) : void 0;
}
function isMember(spec, rel) {
  return spec.include.some((pattern) => matchesWorkspaceGlob(pattern, rel)) && !spec.exclude.some((pattern) => matchesWorkspaceGlob(pattern, rel));
}
function groupLocks(files) {
  const groups = /* @__PURE__ */ new Map();
  for (const file of files) {
    const ecosystem = LOCK_ECOSYSTEMS.get(path9.posix.basename(file));
    if (ecosystem === void 0 || file.split("/").includes("node_modules")) {
      continue;
    }
    const parent = path9.posix.dirname(file);
    const dir = parent === "." ? "" : parent;
    const key = `${ecosystem}\0${dir}`;
    const group = groups.get(key) ?? { dir, ecosystem, lockNames: [] };
    group.lockNames.push(path9.posix.basename(file));
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({ ...group, lockNames: group.lockNames.toSorted() }));
}
function compareProjects(a, b) {
  if (a.dir !== b.dir) {
    return a.dir < b.dir ? -1 : 1;
  }
  if (a.ecosystem === b.ecosystem) {
    return 0;
  }
  return a.ecosystem < b.ecosystem ? -1 : 1;
}
async function discoverProjects(deps, worktree, specs = /* @__PURE__ */ new Map()) {
  const result = await deps.runner.run({ file: "git", args: ["-C", worktree, "ls-files", "-z"] });
  if (result.code !== 0) {
    return void 0;
  }
  const projects = groupLocks(result.stdout.split("\0").filter((file) => file.length > 0));
  const roots = projects.map((project) => ({ project, spec: workspaceOf(worktree, project, specs) })).filter((root) => root.spec !== void 0);
  const kept = projects.filter(
    (project) => !roots.some((root) => {
      if (root.project.ecosystem !== project.ecosystem) {
        return false;
      }
      const rel = relativeBelow(root.project.dir, project.dir);
      return rel !== void 0 && isMember(root.spec, rel);
    })
  );
  return kept.toSorted(compareProjects);
}
function isWorkspaceMember(worktree, project, folder, specs = /* @__PURE__ */ new Map()) {
  const spec = workspaceOf(worktree, project, specs);
  const rel = relativeBelow(project.dir, folder);
  return spec !== void 0 && rel !== void 0 && isMember(spec, rel);
}
var LOCK_ECOSYSTEMS, UV_WORKSPACE_TABLE;
var init_discover = __esm({
  "src/worktree-add/discover.ts"() {
    "use strict";
    LOCK_ECOSYSTEMS = /* @__PURE__ */ new Map([
      ["package-lock.json", "js"],
      ["npm-shrinkwrap.json", "js"],
      ["pnpm-lock.yaml", "js"],
      ["yarn.lock", "js"],
      ["bun.lock", "js"],
      ["bun.lockb", "js"],
      ["uv.lock", "uv"]
    ]);
    UV_WORKSPACE_TABLE = "tool.uv.workspace";
  }
});

// src/worktree-add/exclude.ts
import fs11 from "node:fs";
import path10 from "node:path";
function anchoredPattern(rel) {
  const escaped = rel.replaceAll(GLOB_CHARACTERS, String.raw`\$&`);
  return `/${escaped.endsWith(" ") ? `${escaped.slice(0, -1)}${String.raw`\ `}` : escaped}`;
}
function readExisting(file) {
  try {
    return { ok: true, text: fs11.readFileSync(file, "utf8") };
  } catch (error) {
    return errorCode(error) === "ENOENT" ? { ok: true, text: "" } : { ok: false };
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
  return path10.resolve(worktree, line);
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
    fs11.mkdirSync(path10.dirname(file), { recursive: true });
    fs11.appendFileSync(file, appendText(existing.text, present, missing));
  } catch {
    deps.log.warn(`cannot update ${showText(file)}${FAILURE_TAIL}`);
  }
}
var TEMP_PATTERN, EXCLUDE_HEADER, FAILURE_TAIL, GLOB_CHARACTERS;
var init_exclude = __esm({
  "src/worktree-add/exclude.ts"() {
    "use strict";
    init_paths();
    init_text();
    TEMP_PATTERN = ".alex-loop-tmp-*";
    EXCLUDE_HEADER = "# alex-loop worktree-add: links, dependency clones and copy temps in worktrees, ignored in the main clone already";
    FAILURE_TAIL = "; the worktree links show as untracked and must be removed before git worktree remove";
    GLOB_CHARACTERS = /[*?[\\]/gu;
  }
});

// src/worktree-add/failures.ts
function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}
function isAuthentication(output) {
  if (matchesAny(output, AUTH_CODE_PATTERNS)) {
    return true;
  }
  return E403_PATTERN.test(output) && matchesAny(output, AUTH_MESSAGE_PATTERNS);
}
function classifyFailure(input) {
  const { output, code, timedOut, lockChanged } = input;
  if (lockChanged && code === 0 && !timedOut) {
    return "lock-changed";
  }
  if (matchesAny(output, WRONG_VERSION_PATTERNS)) {
    return "wrong-version";
  }
  if (isAuthentication(output)) {
    return "authentication";
  }
  if (matchesAny(output, ACCESS_DENIED_PATTERNS)) {
    return "access-denied";
  }
  if (matchesAny(output, SANDBOX_PATTERNS)) {
    return "sandbox";
  }
  if (matchesAny(output, LOCK_OUT_OF_SYNC_PATTERNS)) {
    return "lock-out-of-sync";
  }
  if (timedOut) {
    return matchesAny(output, RETRY_PATTERNS) ? "network" : "timeout";
  }
  if (matchesAny(output, NETWORK_PATTERNS)) {
    return "network";
  }
  if (matchesAny(output, VERSION_MENTION_PATTERNS)) {
    return "wrong-version";
  }
  return "other";
}
function classText(failure) {
  return CLASS_TEXT[failure];
}
function outputLines(output) {
  return output.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0);
}
function npmKeyLine(lines) {
  const index = lines.findIndex((line) => NPM_CODE_LINE.test(line));
  if (index === -1) {
    return void 0;
  }
  const code = NPM_CODE_LINE.exec(lines[index] ?? "")?.[1] ?? "";
  const message = lines.slice(index + 1).map((line) => NPM_MESSAGE_LINE.exec(line)?.[1]).find((text) => text !== void 0);
  return message === void 0 ? `npm error code ${code}` : `npm error code ${code}: ${message}`;
}
function keyErrorLines(output) {
  const lines = outputLines(output);
  const npm = npmKeyLine(lines);
  if (npm !== void 0) {
    return [npm];
  }
  const uv = lines.filter((line) => UV_KEY_LINE.test(line));
  if (uv.length > 0) {
    return uv.slice(-TAIL_LINES);
  }
  return lines.slice(-TAIL_LINES);
}
function pnpmPackageName(prefix) {
  if (prefix === ".") {
    return "the project";
  }
  const index = prefix.lastIndexOf(NODE_MODULES);
  return index === -1 ? prefix : prefix.slice(index + NODE_MODULES.length);
}
function lifecycleStepOf(line) {
  const npm = NPM_SCRIPT_HEADER.exec(line);
  if (npm !== null) {
    return `${npm[2] ?? ""} of ${npm[1] ?? ""}`;
  }
  const pnpm = PNPM_SCRIPT_LINE.exec(line);
  if (pnpm !== null) {
    return `${pnpm[2] ?? ""} of ${pnpmPackageName(pnpm[1] ?? "")}`;
  }
  return void 0;
}
function lastLifecycleStep(output) {
  const lines = outputLines(output);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const step = lifecycleStepOf(lines[index] ?? "");
    if (step !== void 0) {
      return step;
    }
  }
  return void 0;
}
function nextStep(failure, silent) {
  const step = NEXT_STEP[failure];
  return failure === "timeout" && silent ? `${step}; ${SILENT_TIMEOUT_HINT}` : step;
}
function headline(report2) {
  const where = report2.where === "" ? "" : ` in ${showText(report2.where)}`;
  const keys = report2.keyLines.length === 0 ? "" : ` (${report2.keyLines.map((line) => showText(line)).join("; ")})`;
  return `cannot install dependencies with ${showText(report2.manager)}${where}: ${classText(report2.failure)}${keys}`;
}
function logLine(report2) {
  const manager = showText(report2.manager);
  if (report2.logPath !== void 0) {
    return `full ${manager} output: ${showText(report2.logPath)}`;
  }
  if (report2.logProblem !== void 0) {
    return `cannot save the ${manager} output: ${showText(report2.logProblem)}`;
  }
  return void 0;
}
function failureLines(report2) {
  const lines = [headline(report2)];
  for (const folder of report2.missing) {
    lines.push(`${showText(folder)} is left missing: code that needs it fails until it is installed`);
  }
  const step = nextStep(report2.failure, report2.silent);
  lines.push(`to install: ${showText(step)}, then run in the worktree: ${showText(report2.command)}`);
  const log = logLine(report2);
  if (log !== void 0) {
    lines.push(log);
  }
  if (report2.failure === "timeout" && report2.lifecycleStep !== void 0) {
    lines.push(`last step seen: ${showText(report2.lifecycleStep)}`);
  }
  return lines;
}
var WRONG_VERSION_PATTERNS, VERSION_MENTION_PATTERNS, AUTH_CODE_PATTERNS, AUTH_MESSAGE_PATTERNS, E403_PATTERN, ACCESS_DENIED_PATTERNS, SANDBOX_PATTERNS, LOCK_OUT_OF_SYNC_PATTERNS, NETWORK_PATTERNS, RETRY_PATTERNS, NPM_CODE_LINE, NPM_MESSAGE_LINE, UV_KEY_LINE, NPM_SCRIPT_HEADER, PNPM_SCRIPT_LINE, NODE_MODULES, TAIL_LINES, CLASS_TEXT, NEXT_STEP, SILENT_TIMEOUT_HINT;
var init_failures = __esm({
  "src/worktree-add/failures.ts"() {
    "use strict";
    init_text();
    WRONG_VERSION_PATTERNS = [/\bERR_PNPM_LOCKFILE_BREAKING_CHANGE\b/u, /lockfile[^\n]*breaking change/iu];
    VERSION_MENTION_PATTERNS = [/\bpackageManager\b/u, /\bcorepack\b/iu];
    AUTH_CODE_PATTERNS = [
      /\bE401\b/u,
      /\bENEEDAUTH\b/u,
      /\bERR_PNPM_FETCH_401\b/u,
      /\bYN0041\b/u,
      /\b401 Unauthori[sz]ed\b/iu,
      /\bUnauthori[sz]ed - 401\b/iu,
      /\b(?:HTTP(?:\/[\d.]+)?|status(?: code)?|GET|PUT|POST)[\s:]+401\b/iu
    ];
    AUTH_MESSAGE_PATTERNS = [
      /authenticat/iu,
      /unauthori[sz]ed/iu,
      /\btoken\b/iu,
      /\blog(?:ged)? ?in\b/iu,
      /credential/iu
    ];
    E403_PATTERN = /\bE403\b/u;
    ACCESS_DENIED_PATTERNS = [
      E403_PATTERN,
      /\bERR_PNPM_FETCH_403\b/u,
      /\b403 Forbidden\b/iu,
      /\bForbidden - 403\b/iu,
      /\b(?:HTTP(?:\/[\d.]+)?|status(?: code)?|GET|PUT|POST)[\s:]+403\b/iu
    ];
    SANDBOX_PATTERNS = [/\bEACCES\b/u, /\bEPERM\b/u, /\bEROFS\b/u];
    LOCK_OUT_OF_SYNC_PATTERNS = [
      /\bEUSAGE\b/u,
      /\bERR_PNPM_OUTDATED_LOCKFILE\b/u,
      /Your lockfile needs to be updated/u,
      /\bYN0028\b/u,
      /The lockfile would have been modified/u,
      /needs to be updated/u
    ];
    NETWORK_PATTERNS = [
      /\bECONNREFUSED\b/u,
      /\bENOTFOUND\b/u,
      /\bE?TIMEDOUT\b/u,
      /\bESOCKETTIMEDOUT\b/u,
      /\bEAI_AGAIN\b/u,
      /\bECONNRESET\b/u,
      /\bEHOSTUNREACH\b/u,
      /\bENETUNREACH\b/u,
      /\bFETCH_ERROR\b/u,
      /network timeout at:/u,
      /socket hang up/iu,
      /\btimed out\b/iu,
      /Will retry/iu,
      /\bretrying\b/iu
    ];
    RETRY_PATTERNS = [/Will retry/iu, /\bretrying\b/iu, /\bETIMEDOUT\b/u, /\bECONNRESET\b/u];
    NPM_CODE_LINE = /^npm (?:error|ERR!) code (\S+)/u;
    NPM_MESSAGE_LINE = /^npm (?:error|ERR!) (.+)$/u;
    UV_KEY_LINE = /^(?:error|hint):/u;
    NPM_SCRIPT_HEADER = /^> (\S+@\S+) (\S+)/u;
    PNPM_SCRIPT_LINE = /^(\S+) (preinstall|install|postinstall|prepare)\$/u;
    NODE_MODULES = "node_modules/";
    TAIL_LINES = 5;
    CLASS_TEXT = {
      authentication: "authentication failed",
      "access-denied": "access denied",
      network: "network unreachable",
      "lock-out-of-sync": "lock file out of sync",
      "lock-changed": "the install changed the lock file",
      "wrong-version": "wrong manager version",
      sandbox: "blocked by a sandbox",
      "tool-missing": "tool missing",
      timeout: "timed out",
      other: "failed"
    };
    NEXT_STEP = {
      authentication: "log in to the registry or refresh the token",
      "access-denied": "check the token, or a proxy or sandbox that blocks the registry",
      network: "check the connection or VPN",
      "lock-out-of-sync": "update the lock file in the branch",
      "lock-changed": "use the manager version the project pins",
      "wrong-version": "enable corepack or install the named version",
      sandbox: "rerun outside the sandbox or with network and home access",
      "tool-missing": "install the manager (or enable corepack)",
      timeout: "give the install more time",
      other: "see the key error lines and the log file"
    };
    SILENT_TIMEOUT_HINT = "no output at all, often a network that silently drops packets (VPN or proxy)";
  }
});

// src/worktree-add/fallback.ts
import fs12 from "node:fs";
import path11 from "node:path";
function makeLink(run, rel) {
  const dest = path11.join(run.worktree, rel);
  if (lstatOrUndefined(dest) !== void 0) {
    return "exists";
  }
  try {
    fs12.symlinkSync(path11.join(run.main, rel), dest);
    return "created";
  } catch (error) {
    const code = errorCode(error);
    if (code === "EEXIST") {
      return "exists";
    }
    run.deps.log.warn(`cannot link ${showText(rel)} into the worktree: ${showText(code)}`);
    return "failed";
  }
}
function ensureLink(run, rel) {
  const result = makeLink(run, rel);
  if (result === "exists") {
    return isOwnLink(run, rel) ? "linked" : "present";
  }
  return result === "created" ? "linked" : "failed";
}
async function cloneOrLink(run, rel) {
  const outcome = await run.transfer.cloneDependency(rel);
  if (outcome.kind === "cloned") {
    return "cloned";
  }
  const kind = ensureLink(run, rel);
  if (outcome.kind === "unavailable" && kind === "linked") {
    run.deps.log.info(`linked ${showText(rel)}: ${showText(outcome.reason)}`);
  }
  if (outcome.kind === "failed") {
    const fallback = kind === "linked" ? "; linked it instead" : "";
    run.deps.log.warn(`cannot clone ${showText(rel)} into the worktree (${showText(outcome.reason)})${fallback}`);
  }
  return kind;
}
async function fallbackFor(run, rel) {
  if (!parentExists(run.worktree, rel)) {
    return "no-parent";
  }
  if (!parentInside(run.worktree, rel) || !missingOrOwnLink(run, rel)) {
    return "present";
  }
  if (path11.posix.basename(rel) === JS_DEPS) {
    return cloneOrLink(run, rel);
  }
  return ensureLink(run, rel);
}
async function applyFallback(deps, paths2, transfer, rels) {
  const run = { deps, main: paths2.main, worktree: paths2.worktree, transfer };
  const results = [];
  for (const rel of rels) {
    results.push({ rel, kind: await fallbackFor(run, rel) });
  }
  return results;
}
var init_fallback = __esm({
  "src/worktree-add/fallback.ts"() {
    "use strict";
    init_paths();
    init_text();
  }
});

// src/worktree-add/cleanup.ts
import fs13 from "node:fs";
import path12 from "node:path";
function withoutTrailingSeparators(file) {
  let result = file;
  while (result.length > 1 && (result.endsWith("/") || result.endsWith(path12.sep))) {
    result = result.slice(0, -1);
  }
  return result;
}
async function listUntracked(deps, dir) {
  const listed = await deps.runner.run({
    file: "git",
    args: ["-C", dir, "ls-files", "-z", "--others", "--directory"]
  });
  if (listed.code !== 0) {
    return { ok: false, reason: failureLine(listed) };
  }
  const entries = listed.stdout.split("\0").map((entry) => withoutTrailingSeparators(entry)).filter((entry) => entry.length > 0);
  return { ok: true, entries: new Set(entries) };
}
async function untrackedEntries(deps, dir) {
  const listed = await listUntracked(deps, dir);
  return listed.ok ? listed.entries : void 0;
}
function refusal(rel) {
  if (rel.length === 0) {
    return "refused an empty path";
  }
  if (path12.isAbsolute(rel)) {
    return `refused an absolute path: ${showText(rel)}`;
  }
  if (rel.split(/[/\\]/u).includes("..")) {
    return `refused a path with "..": ${showText(rel)}`;
  }
  return;
}
function removeSafely(root, rel) {
  const clean = withoutTrailingSeparators(rel);
  const refused2 = refusal(clean);
  if (refused2 !== void 0) {
    return { ok: false, reason: refused2 };
  }
  if (realOrUndefined(root) !== void 0 && !parentExists(root, clean)) {
    return { ok: true };
  }
  if (!parentInside(root, clean)) {
    return { ok: false, reason: `refused a path whose parent is not inside ${showText(root)}: ${showText(clean)}` };
  }
  const full = path12.join(root, clean);
  const stats = lstatOrUndefined(full);
  if (stats === void 0) {
    return { ok: true };
  }
  try {
    if (stats.isDirectory()) {
      fs13.rmSync(full, { recursive: true, force: true });
    } else {
      fs13.unlinkSync(full);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `cannot remove ${showText(clean)}: ${showText(errorCode(error))}` };
  }
}
function isManagerArtifact(rel) {
  const name = rel.split("/").at(-1) ?? "";
  return TARGET_NAMES.has(name) || ROOT_ARTIFACTS.has(rel);
}
function removeNewYarnFolder(dir) {
  const full = path12.join(dir, YARN_FOLDER);
  if (lstatOrUndefined(full)?.isDirectory() !== true) {
    return { ok: true };
  }
  for (const rel of YARN_ARTIFACTS) {
    const removed = removeSafely(dir, rel);
    if (!removed.ok) {
      return removed;
    }
  }
  try {
    if (fs13.readdirSync(full).length === 0) {
      fs13.rmdirSync(full);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `cannot remove ${showText(YARN_FOLDER)}: ${showText(errorCode(error))}` };
  }
}
function removeNewEntry(dir, rel) {
  if (rel === YARN_FOLDER) {
    return removeNewYarnFolder(dir);
  }
  return isManagerArtifact(rel) ? removeSafely(dir, rel) : { ok: true };
}
async function removeNewEntries(deps, dir, before) {
  const now = await listUntracked(deps, dir);
  if (!now.ok) {
    return { ok: false, leftovers: [], reason: now.reason };
  }
  const leftovers = [];
  let firstReason;
  for (const rel of now.entries) {
    if (before.has(rel)) {
      continue;
    }
    const removed = removeNewEntry(dir, rel);
    if (!removed.ok) {
      leftovers.push(rel);
      firstReason ??= removed.reason;
    }
  }
  if (firstReason === void 0) {
    return { ok: true };
  }
  return { ok: false, leftovers, reason: firstReason };
}
function shellQuote(text) {
  return `'${text.replaceAll("'", String.raw`'\''`)}'`;
}
function removalCommand(paths2) {
  const quoted = paths2.map((file) => shellQuote(withoutTrailingSeparators(file)));
  return ["rm", "-rf", "--", ...quoted].join(" ");
}
var TARGET_NAMES, YARN_FOLDER, YARN_ARTIFACTS, ROOT_ARTIFACTS;
var init_cleanup = __esm({
  "src/worktree-add/cleanup.ts"() {
    "use strict";
    init_paths();
    init_text();
    TARGET_NAMES = /* @__PURE__ */ new Set([JS_DEPS, UV_VENV]);
    YARN_FOLDER = ".yarn";
    YARN_ARTIFACTS = [".yarn/install-state.gz", ".yarn/unplugged", ".yarn/cache"];
    ROOT_ARTIFACTS = /* @__PURE__ */ new Set([
      ".pnp.cjs",
      ".pnp.loader.mjs",
      ".pnp.data.json",
      ...YARN_ARTIFACTS
    ]);
  }
});

// src/worktree-add/privateArea.ts
import fs14 from "node:fs";
import path13 from "node:path";
async function privateDir(deps, worktree) {
  const result = await deps.runner.run({ file: "git", args: ["-C", worktree, "rev-parse", "--absolute-git-dir"] });
  const dir = result.stdout.trim();
  if (result.code !== 0 || dir.length === 0) {
    return;
  }
  return dir;
}
function nameSafe(text) {
  let result = "";
  for (const char of text) {
    if (SAFE_NAME_CHARACTER.test(char)) {
      result += char;
      continue;
    }
    for (const byte of Buffer.from(char, "utf8")) {
      result += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return result;
}
function logFileName(manager, projectDir) {
  const trimmed = projectDir.replace(/\/+$/u, "");
  if (trimmed === "" || trimmed === ".") {
    return `${LOG_PREFIX}-${nameSafe(manager)}.log`;
  }
  return `${LOG_PREFIX}-${nameSafe(manager)}-${nameSafe(trimmed)}.log`;
}
function writeInstallLog(dir, fileName, text) {
  const file = path13.join(dir, fileName);
  const noFollow = fs14.constants.O_NOFOLLOW ?? 0;
  const flags = fs14.constants.O_WRONLY | fs14.constants.O_CREAT | fs14.constants.O_TRUNC | noFollow;
  let fd;
  try {
    fd = fs14.openSync(file, flags, LOG_MODE);
    fs14.fchmodSync(fd, LOG_MODE);
    fs14.writeFileSync(fd, text);
    return { ok: true, path: file };
  } catch (error) {
    return { ok: false, reason: errorCode(error) };
  } finally {
    if (fd !== void 0) {
      fs14.closeSync(fd);
    }
  }
}
function readMarks(dir) {
  let text;
  try {
    text = fs14.readFileSync(path13.join(dir, PARTIAL_MARKER), "utf8");
  } catch (error) {
    return errorCode(error) === "ENOENT" ? [] : void 0;
  }
  return [...new Set(text.split("\n").filter((line) => line.length > 0))];
}
function readPartialMarks(dir) {
  return readMarks(dir) ?? [];
}
function writePartialMarks(dir, rels) {
  const file = path13.join(dir, PARTIAL_MARKER);
  try {
    if (rels.length === 0) {
      fs14.rmSync(file, { force: true });
    } else {
      fs14.writeFileSync(file, `${rels.join("\n")}
`);
    }
    return true;
  } catch {
    return false;
  }
}
function addPartialMarks(dir, rels) {
  const marks = readMarks(dir);
  if (marks === void 0) {
    return false;
  }
  return writePartialMarks(dir, [.../* @__PURE__ */ new Set([...marks, ...rels])]);
}
function clearPartialMarks(dir, rels) {
  const marks = readMarks(dir);
  if (marks === void 0) {
    return false;
  }
  const cleared = new Set(rels);
  return writePartialMarks(
    dir,
    marks.filter((rel) => !cleared.has(rel))
  );
}
var PARTIAL_MARKER, LOG_PREFIX, LOG_MODE, SAFE_NAME_CHARACTER;
var init_privateArea = __esm({
  "src/worktree-add/privateArea.ts"() {
    "use strict";
    init_paths();
    PARTIAL_MARKER = "alex-loop-partial-install";
    LOG_PREFIX = "alex-loop-install";
    LOG_MODE = 384;
    SAFE_NAME_CHARACTER = /^[\w.-]$/u;
  }
});

// src/worktree-add/leftovers.ts
import path14 from "node:path";
function deepestAbove(sites, rel) {
  let best;
  for (const site of sites) {
    if (isAtOrAbove(site.dir, rel) && (best === void 0 || site.dir.length > best.dir.length)) {
      best = site;
    }
  }
  return best;
}
function markOwner(sites, rel) {
  const ecosystem = path14.posix.basename(rel) === JS_DEPS ? "js" : "uv";
  return deepestAbove(
    sites.filter((site) => site.ecosystem === ecosystem),
    rel
  ) ?? deepestAbove(sites, rel);
}
function removeMarkedLeftovers(scope, owns) {
  const dir = scope.privateDir;
  if (dir === void 0) {
    return { ok: true };
  }
  const removed = [];
  const failed = [];
  let firstReason;
  for (const rel of readPartialMarks(dir).filter((mark) => owns(mark))) {
    const result = removeSafely(scope.worktree, rel);
    if (result.ok) {
      removed.push(rel);
    } else {
      failed.push(rel);
      firstReason ??= result.reason;
    }
  }
  if (removed.length > 0 && !clearPartialMarks(dir, removed)) {
    scope.deps.log.warn(`cannot update the partial install marker in ${showText(dir)}`);
  }
  if (firstReason === void 0) {
    return { ok: true };
  }
  const command = removalCommand(failed.map((rel) => path14.join(scope.worktree, rel)));
  return {
    ok: false,
    failed,
    problem: `cannot remove the partial install of an earlier run: ${showText(firstReason)}; remove it with: ${showText(command)}`
  };
}
var init_leftovers = __esm({
  "src/worktree-add/leftovers.ts"() {
    "use strict";
    init_cleanup();
    init_paths();
    init_privateArea();
    init_text();
  }
});

// src/worktree-add/installProject.ts
import path15 from "node:path";
function ranManager(outcome) {
  return outcome.kind === "installed" || outcome.kind === "failed";
}
function worktreeRel(project, rel) {
  return project.dir === "" ? rel : `${project.dir}/${rel}`;
}
function projectRel(project, rel) {
  return project.dir === "" ? rel : rel.slice(project.dir.length + 1);
}
function defaultFolder(project) {
  return worktreeRel(project, project.ecosystem === "js" ? JS_DEPS : UV_VENV);
}
function projectPlace(project) {
  return project.dir === "" ? "the worktree root" : showText(project.dir);
}
function projectLabel(project, manager) {
  return project.dir === "" ? manager : `${manager} in ${showText(project.dir)}`;
}
function targetFolders(project) {
  return [.../* @__PURE__ */ new Set([...project.depRels, defaultFolder(project)])];
}
function shellWord(text) {
  return SHELL_SAFE.test(text) ? text : shellQuote(text);
}
function projectCommand(project, command) {
  return project.dir === "" ? command : `cd ${shellWord(project.dir)} && ${command}`;
}
function projectPath(run) {
  return path15.join(run.ctx.worktree, run.project.dir);
}
function absolutePaths(run, rels) {
  return rels.map((rel) => path15.join(run.ctx.worktree, rel));
}
function missingTargets(run) {
  return run.targets.filter((rel) => lstatOrUndefined(path15.join(run.ctx.worktree, rel)) === void 0);
}
function addMarks(run, rels) {
  const dir = run.ctx.privateDir;
  if (dir !== void 0 && rels.length > 0 && !addPartialMarks(dir, rels)) {
    run.ctx.deps.log.warn(`cannot record the partial install of ${run.label} in ${showText(dir)}`);
  }
}
function clearMarks(run, rels) {
  const dir = run.ctx.privateDir;
  if (dir !== void 0 && rels.length > 0 && !clearPartialMarks(dir, rels)) {
    run.ctx.deps.log.warn(`cannot update the partial install marker in ${showText(dir)}`);
  }
}
function logGroup(run, report2) {
  const lines = failureLines({
    ...report2,
    manager: executableOf(run.manager),
    where: run.project.dir,
    command: projectCommand(run.project, installCommand(run.manager)),
    missing: missingTargets(run)
  });
  for (const line of lines) {
    run.ctx.deps.log.warn(line);
  }
}
function logNoTimeLeft(run) {
  logGroup(run, {
    failure: "timeout",
    keyLines: ["no time was left to check the manager version"],
    logPath: void 0,
    logProblem: void 0,
    lifecycleStep: void 0,
    silent: false
  });
}
function logWrongVersion(run, expected, found) {
  logGroup(run, {
    failure: "wrong-version",
    keyLines: [`expected ${expected}, found ${maskSecrets(found, run.ctx.env)}`],
    logPath: void 0,
    logProblem: void 0,
    lifecycleStep: void 0,
    silent: false
  });
}
function clearProjectLeftovers(ctx, project, label) {
  const removal = removeMarkedLeftovers(ctx, (rel) => {
    const owner = markOwner(ctx.projects, rel);
    return owner?.dir === project.dir && owner.ecosystem === project.ecosystem;
  });
  if (removal.ok) {
    return true;
  }
  ctx.deps.log.warn(`not installed with ${label}: ${removal.problem}`);
  return false;
}
function blockedTargets(run) {
  return run.targets.filter(
    (rel) => lstatOrUndefined(path15.join(run.ctx.worktree, rel)) !== void 0 && !isOwnLink(run.ctx, rel)
  );
}
function shownList(rels) {
  return rels.map((rel) => showText(rel)).join(", ");
}
function warnBlocked(run, blocked) {
  const shown = shownList(blocked);
  const tail = blocked.length === 1 ? "already stands in the worktree and is left as it is" : "already stand in the worktree and are left as they are";
  const pronoun = blocked.length === 1 ? "it" : "them";
  run.ctx.deps.log.warn(`not installed with ${run.label}: ${shown} ${tail} (remove ${pronoun} and rerun to install)`);
}
function relink(run, unlinked) {
  return unlinked.filter((rel) => makeLink(run.ctx, rel) === "created");
}
function warnRestored(run, restored) {
  if (restored.length === 0) {
    return;
  }
  const command = ["rm", "--", ...absolutePaths(run, restored).map((file) => shellQuote(file))].join(" ");
  run.ctx.deps.log.warn(
    `not installed with ${run.label}: the earlier link was restored for ${shownList(restored)}; remove it with ${showText(command)} before installing`
  );
}
function unlinkOwnLinks(run) {
  const unlinked = [];
  for (const rel of run.targets) {
    if (!isOwnLink(run.ctx, rel)) {
      continue;
    }
    const result = removeSafely(run.ctx.worktree, rel);
    if (!result.ok) {
      run.ctx.deps.log.warn(`not installed with ${run.label}: ${showText(result.reason)}`);
      warnRestored(run, relink(run, unlinked));
      return;
    }
    unlinked.push(rel);
  }
  return unlinked;
}
function saveLog(run, output) {
  const dir = run.ctx.privateDir;
  if (dir === void 0) {
    return { logPath: void 0, logProblem: NO_PRIVATE_DIR };
  }
  const written = writeInstallLog(dir, logFileName(executableOf(run.manager), run.project.dir), output);
  return written.ok ? { logPath: written.path, logProblem: void 0 } : { logPath: void 0, logProblem: written.reason };
}
function warnUnlisted(run, reason) {
  const dir = projectPath(run);
  const shownReason = showText(maskSecrets(reason, run.ctx.env));
  run.ctx.deps.log.warn(
    `cannot list what the install created in ${showText(dir)} (${shownReason}); check it with: ${showText(`git -C ${shellQuote(dir)} status --ignored`)}`
  );
}
async function cleanUp(run, before) {
  const removed = await removeNewEntries(run.ctx.deps, projectPath(run), before);
  const listingFailed = !removed.ok && removed.leftovers.length === 0;
  const leftovers = removed.ok ? [] : removed.leftovers.map((rel) => worktreeRel(run.project, rel));
  let reason = removed.ok || listingFailed ? void 0 : removed.reason;
  for (const rel of run.targets) {
    if (leftovers.includes(rel)) {
      continue;
    }
    const result = removeSafely(run.ctx.worktree, rel);
    if (!result.ok) {
      leftovers.push(rel);
      reason ??= result.reason;
    }
  }
  if (!removed.ok && listingFailed) {
    warnUnlisted(run, removed.reason);
  }
  if (reason === void 0) {
    clearMarks(run, run.targets);
    return;
  }
  addMarks(run, leftovers);
  clearMarks(
    run,
    run.targets.filter((rel) => !leftovers.includes(rel))
  );
  const command = removalCommand(absolutePaths(run, leftovers));
  run.ctx.deps.log.warn(
    `cannot remove the partial install: ${showText(reason)}; remove it with: ${showText(command)}`
  );
}
async function reportFailure(run, result, state) {
  const { env, deps } = run.ctx;
  const output = maskSecrets(result.output, env);
  const lastOutput = maskSecrets(result.lastOutput, env);
  if (result.lockRestoreProblem !== void 0) {
    deps.log.warn(
      `cannot restore the lock file after ${run.label}: ${showText(maskSecrets(result.lockRestoreProblem, env))}`
    );
  }
  const failure = classifyFailure({
    output: lastOutput,
    code: result.code,
    timedOut: result.timedOut,
    lockChanged: result.lockChanged
  });
  await cleanUp(run, state.before);
  const restored = relink(run, state.unlinked);
  logGroup(run, {
    failure,
    keyLines: keyErrorLines(lastOutput),
    ...saveLog(run, output),
    lifecycleStep: lastLifecycleStep(lastOutput),
    silent: result.lastOutput.trim().length === 0
  });
  warnRestored(run, restored);
}
async function installChecked(run, deadlineMs) {
  const { deps } = run.ctx;
  const blocked = blockedTargets(run);
  if (blocked.length > 0) {
    warnBlocked(run, blocked);
    return { kind: "not-installed" };
  }
  const listed = await untrackedEntries(deps, projectPath(run));
  if (listed === void 0) {
    deps.log.warn(
      `not installed with ${run.label}: cannot list the untracked entries of ${showText(projectPath(run))}`
    );
    return { kind: "not-installed" };
  }
  const unlinked = unlinkOwnLinks(run);
  if (unlinked === void 0) {
    return { kind: "not-installed" };
  }
  const before = new Set(listed);
  for (const rel of unlinked) {
    before.delete(projectRel(run.project, rel));
  }
  addMarks(run, run.targets);
  const result = await runInstall(deps, {
    manager: run.manager,
    projectDir: projectPath(run),
    label: run.label,
    lockFiles: run.project.lockNames.map((name) => path15.join(projectPath(run), name)),
    deadlineMs,
    nowMs: run.ctx.nowMs,
    networkTimeoutMs: run.ctx.networkTimeoutMs,
    progressMs: run.ctx.progressMs
  });
  if (result.ok) {
    deps.log.info(`installed dependencies with ${run.label} in ${(result.elapsedMs / 1e3).toFixed(1)} s`);
    clearMarks(run, run.targets);
    return { kind: "installed" };
  }
  await reportFailure(run, result, { before, unlinked });
  return { kind: "failed" };
}
async function installProject(ctx, project, deadlineMs, choice) {
  const name = choice.kind === "conflict" ? CONFLICT_MANAGER : executableOf(choice.manager);
  if (!clearProjectLeftovers(ctx, project, projectLabel(project, name))) {
    return { kind: "not-installed" };
  }
  if (choice.kind === "conflict") {
    ctx.deps.log.warn(`cannot install dependencies in ${projectPlace(project)}: ${showText(choice.reason)}`);
    return { kind: "not-installed" };
  }
  const projectDir = path15.join(ctx.worktree, project.dir);
  const { manager } = choice;
  const run = { ctx, project, manager, label: projectLabel(project, name), targets: targetFolders(project) };
  const leftMs = deadlineMs - ctx.nowMs();
  if (leftMs <= 0) {
    logNoTimeLeft(run);
    return { kind: "not-installed" };
  }
  const version = await checkManagerVersion(
    ctx.deps,
    manager,
    choice.expected,
    projectDir,
    Math.min(VERSION_TIMEOUT_MS, leftMs)
  );
  if (version.kind === "missing") {
    return { kind: "tool-missing", manager: name };
  }
  if (version.kind === "mismatch") {
    logWrongVersion(run, version.expected, version.found);
    return { kind: "not-installed" };
  }
  if (version.kind === "differs") {
    ctx.deps.log.info(
      `installing with ${run.label} although package.json packageManager names ${version.expected}, found ${version.found} (npm does not enforce packageManager)`
    );
  }
  return installChecked(run, deadlineMs);
}
var CONFLICT_MANAGER, SHELL_SAFE, NO_PRIVATE_DIR;
var init_installProject = __esm({
  "src/worktree-add/installProject.ts"() {
    "use strict";
    init_attempt();
    init_cleanup();
    init_failures();
    init_fallback();
    init_leftovers();
    init_managers();
    init_mask();
    init_paths();
    init_privateArea();
    init_text();
    CONFLICT_MANAGER = "the package manager";
    SHELL_SAFE = /^[\w./-]+$/u;
    NO_PRIVATE_DIR = "the worktree has no private git folder";
  }
});

// src/worktree-add/installStage.ts
import path16 from "node:path";
function shownList2(rels) {
  return rels.map((rel) => showText(rel)).join(", ");
}
function groupTexts(results, groups) {
  return groups.map(([kind, text]) => ({ text, rels: results.filter((result) => result.kind === kind) })).filter((group) => group.rels.length > 0).map((group) => group.text(shownList2(group.rels.map((result) => result.rel))));
}
function paths(request) {
  return { main: request.main, worktree: request.worktree };
}
function commandOf({ project, choice }) {
  if (choice.kind === "conflict") {
    return { manager: CONFLICT_MANAGER, command: CONFLICT_COMMAND };
  }
  return {
    manager: executableOf(choice.manager),
    command: projectCommand(project, installCommand(choice.manager))
  };
}
function overlaps(a, b) {
  return isAtOrAbove(a, b) || isAtOrAbove(b, a);
}
async function skipAll(request, dir) {
  const { deps, worktree } = request;
  const removal = removeMarkedLeftovers({ deps, worktree, privateDir: dir }, () => true);
  const failed = removal.ok ? [] : removal.failed;
  if (!removal.ok) {
    deps.log.warn(removal.problem);
  }
  const rels = request.depRels.filter((rel) => !failed.some((mark) => overlaps(rel, mark)));
  const results = await applyFallback(deps, paths(request), request.transfer, rels);
  const groups = groupTexts(results, NO_INSTALL_GROUPS);
  const summary = groups.length === 0 ? "no dependency folders in the main clone" : groups.join("; ");
  deps.log.info(`installs skipped (--no-install): ${summary}`);
}
function labelOf(plan) {
  return projectLabel(plan.project, commandOf(plan).manager);
}
function reportManual(request, planned) {
  for (const plan of planned) {
    if (!plan.project.auto) {
      const run = `(run in the worktree: ${showText(commandOf(plan).command)})`;
      request.deps.log.info(`not installed automatically: ${showText(plan.project.dir)} ${run}`);
    }
  }
}
async function sandboxFallback(stage, planned) {
  const { request, ctx } = stage;
  const results = [];
  for (const plan of planned) {
    if (clearProjectLeftovers(ctx, plan.project, labelOf(plan))) {
      results.push(...await applyFallback(ctx.deps, paths(request), request.transfer, plan.project.depRels));
    }
  }
  const done = groupTexts(results, NO_INSTALL_GROUPS).map((text) => `; ${text}`);
  const commands = planned.map((plan) => showText(commandOf(plan).command)).join("; ");
  const later = results.some((result) => result.kind === "linked") ? "to install later, remove the linked folders first (rm PATH, no trailing slash), then run in the worktree" : "run later in the worktree";
  const tail = commands.length === 0 ? "" : `; ${later}: ${commands}`;
  ctx.deps.log.info(`installs skipped: the network is disabled in this sandbox${done.join("")}${tail}`);
}
function orphanReason(rel, projects) {
  if (path16.posix.basename(rel) === JS_DEPS) {
    const parent = rel.includes("/") ? path16.posix.dirname(rel) : "";
    const owner = projects.filter((project) => project.ecosystem === "js" && isAtOrAbove(project.dir, parent)).toSorted((a, b) => b.dir.length - a.dir.length)[0];
    return owner === void 0 ? `${showText(rel)} belongs to no project with a supported lock file` : `${showText(rel)} is outside the workspaces of the JS project in ${projectPlace(owner)}`;
  }
  return `${showText(rel)} is a Python environment with no uv.lock next to it, and poetry, pip and pipenv are not installed automatically`;
}
function kindText(result) {
  if (result.kind === "no-parent") {
    return `skipped: ${showText(path16.posix.dirname(result.rel))} does not exist in the worktree`;
  }
  return ORPHAN_KIND_TEXT[result.kind];
}
async function handleOrphans(request, orphans, projects) {
  const results = await applyFallback(request.deps, paths(request), request.transfer, orphans);
  for (const result of results) {
    request.deps.log.warn(`not installed: ${orphanReason(result.rel, projects)}; ${kindText(result)}`);
  }
}
async function handleLinkOnly(request, planned) {
  for (const { project } of planned) {
    const results = await applyFallback(request.deps, paths(request), request.transfer, project.linkOnly);
    for (const result of results) {
      request.deps.log.warn(
        `not installed: ${showText(result.rel)} belongs to the uv project in ${projectPlace(project)}, which installs only its own .venv; ${kindText(result)}`
      );
    }
  }
}
function toolMissingTail(project, results) {
  if (results.length === 0) {
    return `nothing to link: ${shownList2(targetFolders(project))} stays missing`;
  }
  return groupTexts(results, TOOL_MISSING_GROUPS).join("; ");
}
async function handleToolMissing(request, project, manager) {
  const results = await applyFallback(request.deps, paths(request), request.transfer, project.depRels);
  const shown = showText(manager);
  const where = project.dir === "" ? "" : ` in ${showText(project.dir)}`;
  request.deps.log.warn(`cannot install dependencies with ${shown}${where}: ${shown} is not on PATH`);
  request.deps.log.warn(
    `to install: install ${shown} (or enable corepack), then rerun from the main clone; ` + toolMissingTail(project, results)
  );
}
function reportNotStarted(stage, plan) {
  const { request, ctx } = stage;
  const { project } = plan;
  clearProjectLeftovers(ctx, project, labelOf(plan));
  const { manager, command } = commandOf(plan);
  const missing = targetFolders(project).filter(
    (rel) => lstatOrUndefined(path16.join(request.worktree, rel)) === void 0
  );
  const lines = failureLines({
    manager,
    where: project.dir,
    failure: "timeout",
    keyLines: [NOT_STARTED],
    missing,
    command,
    logPath: void 0,
    logProblem: void 0,
    lifecycleStep: void 0,
    silent: false
  });
  for (const line of lines) {
    request.deps.log.warn(line);
  }
}
async function takeSnapshot(request) {
  const snapshot = await snapshotSharedConfig(request.deps, request.worktree);
  if (snapshot === void 0) {
    request.deps.log.warn(
      "cannot read the shared repository config; changes made by installs to it are not reverted"
    );
  }
  return snapshot;
}
async function installOne(request, run, { project, choice }, untilMs) {
  const { deps, env } = request;
  let outcome;
  try {
    outcome = await installProject(run.ctx, project, untilMs, choice);
  } catch (error) {
    deps.log.warn(`cannot install dependencies in ${projectPlace(project)}: ${messageOf(error)}`);
  }
  if (run.snapshot !== void 0 && (outcome === void 0 || ranManager(outcome))) {
    try {
      await revertConfigChanges(deps, env, run.snapshot);
    } catch (error) {
      deps.log.warn(
        `cannot revert the shared repository config after installing in ${projectPlace(project)}: ` + messageOf(error)
      );
    }
  }
  if (outcome?.kind === "tool-missing") {
    await handleToolMissing(request, project, outcome.manager);
  }
}
async function installAll(stage, planned) {
  if (planned.length === 0) {
    return;
  }
  const { request, ctx } = stage;
  const { timing, nowMs } = request;
  const snapshot = await takeSnapshot(request);
  const deadline = createDeadline(request.startedMs, timing.phaseMs, nowMs);
  for (const [index, plan] of planned.entries()) {
    if (deadline.remainingMs() < MIN_START_MS) {
      reportNotStarted(stage, plan);
      continue;
    }
    await installOne(request, { ctx, snapshot }, plan, nowMs() + deadline.shareMs(planned.length - index));
  }
}
async function excludeNewTargets(request, planned) {
  const known = new Set(request.depRels);
  const fresh = planned.flatMap((plan) => targetFolders(plan.project)).filter((rel) => !known.has(rel));
  await addExcludePatterns(
    request.deps,
    request.worktree,
    fresh.map((rel) => anchoredPattern(rel))
  );
}
function stageContext(request, dir, projects) {
  return {
    deps: request.deps,
    env: request.env,
    main: request.main,
    worktree: request.worktree,
    privateDir: dir,
    projects,
    nowMs: request.nowMs,
    networkTimeoutMs: request.timing.networkTimeoutMs,
    progressMs: request.timing.progressMs
  };
}
async function runInstallStage(request) {
  const { deps, worktree, depRels } = request;
  const temps = depRels.length > 0 ? [TEMP_PATTERN] : [];
  await addExcludePatterns(deps, worktree, [...temps, ...depRels.map((rel) => anchoredPattern(rel))]);
  const dir = await privateDir(deps, worktree);
  if (request.noInstall) {
    await skipAll(request, dir);
    return;
  }
  const specs = /* @__PURE__ */ new Map();
  const found = await discoverProjects(deps, worktree, specs);
  if (found === void 0) {
    deps.log.warn("cannot list the lock files of the worktree; no dependencies installed");
    return;
  }
  const assignment = assignDependencies(
    found,
    depRels,
    (project, folder) => isWorkspaceMember(worktree, project, folder, specs)
  );
  const planned = assignment.projects.map((project) => ({
    project,
    choice: chooseManager(path16.join(worktree, project.dir), project.ecosystem, project.lockNames)
  }));
  const stage = {
    request,
    ctx: stageContext(request, dir, found)
  };
  reportManual(request, planned);
  const autoProjects = planned.filter((plan) => plan.project.auto);
  await handleOrphans(request, assignment.orphans, found);
  await handleLinkOnly(request, autoProjects);
  if (request.env[SANDBOX_NETWORK_VARIABLE] === "1") {
    await sandboxFallback(stage, autoProjects);
    return;
  }
  await excludeNewTargets(request, autoProjects);
  await installAll(stage, autoProjects);
}
var DEFAULT_TIMING, SANDBOX_NETWORK_VARIABLE, CONFLICT_COMMAND, NOT_STARTED, NO_INSTALL_GROUPS, TOOL_MISSING_GROUPS, ORPHAN_KIND_TEXT;
var init_installStage = __esm({
  "src/worktree-add/installStage.ts"() {
    "use strict";
    init_assign();
    init_attempt();
    init_configGuard();
    init_deadline();
    init_discover();
    init_exclude();
    init_failures();
    init_fallback();
    init_installProject();
    init_leftovers();
    init_managers();
    init_paths();
    init_privateArea();
    init_text();
    DEFAULT_TIMING = {
      phaseMs: INSTALL_PHASE_MS,
      progressMs: 3e4,
      networkTimeoutMs: 3e4
    };
    SANDBOX_NETWORK_VARIABLE = "CODEX_SANDBOX_NETWORK_DISABLED";
    CONFLICT_COMMAND = "install with the project's package manager";
    NOT_STARTED = "the install phase ended before it started";
    NO_INSTALL_GROUPS = [
      ["cloned", (shown) => `cloned ${shown}`],
      ["linked", (shown) => `linked ${shown}`],
      ["present", (shown) => `left as it is ${shown}`],
      ["no-parent", (shown) => `skipped ${shown} (the parent folder does not exist in the worktree)`],
      ["failed", (shown) => `failed ${shown}`]
    ];
    TOOL_MISSING_GROUPS = [
      ["linked", (shown) => `linked ${shown} meanwhile`],
      ["cloned", (shown) => `cloned ${shown} meanwhile`],
      ["present", (shown) => `${shown} already stand in the worktree and are left as they are`],
      ["no-parent", (shown) => `skipped ${shown}: the parent folder does not exist in the worktree`],
      ["failed", (shown) => `${shown} stay missing`]
    ];
    ORPHAN_KIND_TEXT = {
      cloned: "cloned it",
      linked: "linked it; do not run installs in this worktree until the link is removed",
      present: "it already stands in the worktree and is left as it is",
      failed: "it stays missing"
    };
  }
});

// src/worktree-add/repo.ts
import path17 from "node:path";
function gitIn(deps, dir, args) {
  return deps.runner.run({ file: "git", args: ["-C", dir, ...args] });
}
function withoutFinalNewline(text) {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}
function failureLine3(result) {
  if (result.spawnError !== void 0) {
    return showText(result.spawnError);
  }
  const [first = ""] = result.stderr.trim().split("\n", 1);
  return first.length > 0 ? showText(first) : `git exited with code ${String(result.code)}`;
}
async function canonicalDir(deps, dir, flag) {
  const result = await gitIn(deps, dir, ["rev-parse", flag]);
  const value = withoutFinalNewline(result.stdout);
  return result.code === 0 && value.length > 0 ? canonical(path17.resolve(dir, value)) : void 0;
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
    return `cannot check whether ${showText(dir)} is inside a superproject: ${failureLine3(result)}`;
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
  return { error: `cannot check the branch name ${showText(branch)}: ${failureLine3(result)}` };
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
import path18 from "node:path";
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
    (entry) => !matchesTarget(entry.path, target) && namesTicket(path18.basename(entry.path), key)
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

// src/worktree-add/sync.ts
import path19 from "node:path";
function classify(rel) {
  const name = path19.posix.basename(rel);
  if (COPY_NAMES.has(name) || name.startsWith(COPY_PREFIX)) {
    return "copy";
  }
  if (DEPENDENCY_NAMES.has(name)) {
    return "dep";
  }
  if (SKIP_NAMES.has(name) || name.endsWith(SKIP_SUFFIX)) {
    return "skip";
  }
  return "link";
}
function isVenvFolder(main2, rel) {
  const folder = path19.join(main2, rel);
  return lstatOrUndefined(folder)?.isDirectory() === true && lstatOrUndefined(path19.join(folder, VENV_MARKER)) !== void 0;
}
function entryClass(main2, rel) {
  const kind = classify(rel);
  return kind === "link" && isVenvFolder(main2, rel) ? "dep" : kind;
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
function destinationOpen(run, rel, kind) {
  return kind === "copy" ? missingOrOwnLink(run, rel) : lstatOrUndefined(path19.join(run.worktree, rel)) === void 0;
}
async function syncEntry(run, rel, kind) {
  if (kind === "skip" || kind === "dep" || !parentInside(run.worktree, rel) || !destinationOpen(run, rel, kind)) {
    return;
  }
  switch (kind) {
    case "copy": {
      await run.transfer.copyEntry(rel);
      return;
    }
    case "link": {
      if (makeLink(run, rel) === "created") {
        run.linked.push(rel);
      }
      return;
    }
  }
}
function reportLinks(run) {
  if (run.linked.length > 0) {
    run.deps.log.info(`linked ${run.linked.map((rel) => showText(rel)).join(", ")}`);
  }
}
function excludedPatterns(run, entries) {
  return entries.filter((entry) => entry.kind !== "copy" && entry.kind !== "dep" && isOwnLink(run, entry.rel)).map((entry) => anchoredPattern(entry.rel));
}
async function syncIgnored(deps, main2, worktree, transfer) {
  const listed = await listIgnored(deps, main2);
  if (listed === void 0) {
    deps.log.warn(
      `cannot list the ignored files of ${showText(main2)}; nothing synced into the worktree, the dependency fallback is skipped and nested projects are not installed automatically`
    );
    return void 0;
  }
  const entries = usableEntries(deps, listed).map((rel) => ({ rel, kind: entryClass(main2, rel) }));
  const run = { deps, main: main2, worktree, transfer, linked: [] };
  if (entries.some((entry) => entry.kind === "copy")) {
    await addExcludePatterns(deps, worktree, [TEMP_PATTERN]);
  }
  for (const entry of entries) {
    await syncEntry(run, entry.rel, entry.kind);
  }
  reportLinks(run);
  await addExcludePatterns(deps, worktree, excludedPatterns(run, entries));
  return entries.filter((entry) => entry.kind === "dep").map((entry) => entry.rel);
}
var COPY_NAMES, COPY_PREFIX, DEPENDENCY_NAMES, VENV_MARKER, SKIP_NAMES, SKIP_SUFFIX, REPLACEMENT_CHARACTER;
var init_sync = __esm({
  "src/worktree-add/sync.ts"() {
    "use strict";
    init_exclude();
    init_fallback();
    init_paths();
    init_text();
    COPY_NAMES = /* @__PURE__ */ new Set([".env", "CLAUDE.local.md", "temp.local"]);
    COPY_PREFIX = ".env.";
    DEPENDENCY_NAMES = /* @__PURE__ */ new Set([JS_DEPS]);
    VENV_MARKER = "pyvenv.cfg";
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
import path20 from "node:path";
function joinedRaw(cwd, parentArg) {
  return path20.isAbsolute(parentArg) ? parentArg : `${cwd}/${parentArg}`;
}
function deriveTarget(suffix, parentArg, cwd, main2) {
  const mainName = path20.basename(main2);
  if (hasControlCharacter(mainName)) {
    return {
      ok: false,
      code: 1,
      message: `the main folder name contains a control character: ${showText(main2)}`
    };
  }
  const parent = canonicalLoose(parentArg === void 0 ? path20.dirname(main2) : joinedRaw(cwd, parentArg));
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
      path: path20.join(parent, name)
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

// src/worktree-add/transfer.ts
import path21 from "node:path";
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
    source: path21.join(main2, rel),
    dest: path21.join(worktree, rel)
  });
  const sweep = (placement) => {
    sweepDeadTemps(path21.dirname(placement.dest), pidAlive, deps.pid);
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
import path22 from "node:path";
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
async function syncQuietly(deps, repo, target, transfer) {
  try {
    return await syncIgnored(deps, repo.main, target.path, transfer);
  } catch (error) {
    deps.log.warn(
      `cannot sync ignored paths into the worktree: ${messageOf(error)}; the dependency fallback from the main clone is skipped and nested projects are not installed automatically`
    );
    return void 0;
  }
}
function mergedTiming(timing) {
  return {
    phaseMs: timing?.phaseMs ?? DEFAULT_TIMING.phaseMs,
    progressMs: timing?.progressMs ?? DEFAULT_TIMING.progressMs,
    networkTimeoutMs: timing?.networkTimeoutMs ?? DEFAULT_TIMING.networkTimeoutMs
  };
}
async function installQuietly(request) {
  try {
    await runInstallStage(request);
  } catch (error) {
    request.deps.log.warn(`cannot install dependencies: ${messageOf(error)}`);
  }
}
async function syncAndInstall(io, context) {
  const { deps } = io;
  const { repo, target } = context;
  const transfer = createTransfer(deps, {
    main: repo.main,
    worktree: target.path,
    gate: io.gate ?? createCloneGate()
  });
  const depRels = await syncQuietly(deps, repo, target, transfer);
  if (depRels === void 0 && context.noInstall) {
    return;
  }
  await installQuietly({
    deps,
    env: io.env,
    main: repo.main,
    worktree: target.path,
    depRels: depRels ?? [],
    noInstall: context.noInstall,
    transfer,
    startedMs: context.startedMs,
    nowMs: io.nowMs ?? Date.now,
    timing: mergedTiming(io.timing)
  });
}
async function prepareTarget(io, repo, suffix, parent) {
  const { deps } = io;
  const derived = deriveTarget(suffix, parent, io.cwd, repo.main);
  if (!derived.ok) {
    return { ok: false, outcome: derived.code === 2 ? usage2(derived.message) : refused(derived.message) };
  }
  const { target } = derived;
  deps.log.info(`name based on main clone folder ${showText(path22.basename(repo.main))}`);
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
  const startedMs = io.startedMs ?? Date.now();
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
  await syncAndInstall(io, { repo, target, noInstall: !parsed.install, startedMs });
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
    init_installStage();
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
import fs15 from "node:fs";
function removeQuietly3(file) {
  try {
    fs15.rmSync(file, { recursive: true, force: true });
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
import fs16 from "node:fs";
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
  const cleanUp2 = async (signal) => {
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
      void cleanUp2(signal);
    };
    listeners.set(signal, listener);
    process.on(signal, listener);
  }
  return uninstall;
}
function writeStderr(text) {
  fs16.writeSync(2, text);
}
function report(deps, outcome) {
  switch (outcome.kind) {
    case "ok": {
      fs16.writeSync(1, `${outcome.path}
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
  const startedMs = Date.now();
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
    const outcome = await run({ deps, env, cwd: process.cwd(), startedMs }, process.argv.slice(2));
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
