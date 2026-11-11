// Default local editing reuses the selected Herdr tab's persistent Neovim.
// Other editors, remote spaces and installations without herdr-nvim retain
// the documented plain terminal editor behavior.
import { appHome, exec, focused, notify, run, shared } from "herdr";
import { basename, editorArgv } from "./git.js";
import { activeSpace } from "./tabs.js";

export const EDITOR_KEY = "tabbed-changes.editor";
const editorName = () => {
  const configured = shared(EDITOR_KEY);
  return typeof configured === "string" && configured.trim() ? configured.trim() : "nvim";
};
export const editorLabel = () => editorName() === "nvim" ? "Neovim" : basename(editorName());

function openPlainEditor(space, source, path, line, editor) {
  const argv = editorArgv(editor, path, line);
  const script = `command -v "$1" >/dev/null 2>&1 || { printf '%s\\n' "$1 is not installed (or not on PATH). Install it, or set shared key tabbed-changes.editor to another editor."; exit 127; }; exec "$@"`;
  run("tab.new", { name: basename(path), space: space.id, folder: source.root, argv: ["sh", "-c", script, "sh", ...argv] });
}
function failed(error) {
  notify({ title: "Open in Neovim failed", body: String(error?.message ?? error).trim().slice(-400), level: "error" });
}

export function openInEditor(cx, source, path, line) {
  const space = activeSpace();
  if (!space) { failed("Select a Herdr space first."); return; }
  const origin = { root: source?.root ?? null, on: source?.on ?? null };
  const editor = editorName();
  const atLine = Number.isFinite(line) && line > 0 ? Math.trunc(line) : null;
  if (editor !== "nvim" || origin.on) { openPlainEditor(space, origin, path, atLine, editor); return; }
  const focus = focused();
  const tab = (focus?.space === space.id && focus.tab) || space.tabs?.find(entry => entry.active)?.id;
  if (!tab) { openPlainEditor(space, origin, path, atLine, editor); return; }
  const context = { space: space.id, tab, terminal: focus?.tab === tab ? focus.terminal ?? null : null, cwd: origin.root };
  const helper = `${appHome()}/mods/herdr-nvim/bin/herdr-nvim`;
  const target = atLine ? `${path}:${atLine}` : path;
  cx.spawn(async () => {
    try {
      const result = await exec(helper, ["open", "--ctx", JSON.stringify(context), target]);
      if (result.code !== 0) failed(result.stderr || result.stdout || `herdr-nvim exited ${result.code}`);
    } catch (error) {
      // Only an absent companion permits the legacy path. Spawn, permission,
      // transport and installed-helper failures must not silently create a tab.
      try {
        const exists = await exec("sh", ["-c", 'test -e "$1" || test -L "$1"', "herdr-nvim-presence", helper]);
        if (exists.code === 1) openPlainEditor(space, origin, path, atLine, editor);
        else failed(error);
      } catch { failed(error); }
    }
  });
}
