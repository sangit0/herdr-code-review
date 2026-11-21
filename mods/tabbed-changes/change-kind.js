// What kind of change a file is: decides the colour of its name. No Herdr imports, so `node` can test it.
// Takes whatever a view knows about a file: a status letter (M A D U R C !), `fresh` (untracked/new) and +/- counts.
export function changeKind({ status, fresh, add, del } = {}) {
  const s = String(status ?? "").toUpperCase();
  if (s === "A" || s === "U" || fresh) return "added";
  if (s === "!") return "conflict";
  if (s === "D") return "deleted";
  if (s === "R" || s === "C") return "renamed";
  if (!s && add === 0 && del > 0) return "deleted";
  return "modified";
}
