// Pure comment context and delivery rules. No Herdr imports, so these are testable in Node.
export function contextForRow(row, source, side = 'new') {
  if (!row?.path || !source?.root) return null;
  if (row.kind === 'c') {
    const cell = side === 'old' ? row.l : row.r;
    return cell?.n ? { source, path: row.path, line: cell.n, side, code: cell.text } : null;
  }
  if (!['+', '-', ' '].includes(row.kind)) return null;
  const old = row.kind === '-' || (row.kind === ' ' && side === 'old');
  const line = old ? row.old : row.next;
  return Number.isInteger(line) && line > 0 ? { source, path: row.path, line, side: old ? 'old' : 'new', code: row.text } : null;
}
export function makeComment(context, text, id) {
  if (!context?.source?.root || !context.path || !context.line) throw new Error('Select a code line first.');
  if (!text.trim()) throw new Error('Write a comment first.');
  if (text.length > 10000) throw new Error('Keep each comment under 10,000 characters.');
  return { ...context, source: { ...context.source }, text: text.trim(), id, createdAt: Date.now(), sentAt: null };
}
export const forSource = (notes, source) => notes.filter(n => n.source.root === source?.root && (n.source.on ?? null) === (source?.on ?? null));
export function formatComments(notes) {
  if (!notes.length) throw new Error('Select at least one saved comment.');
  return ['Please address these code review comments. Code and line numbers are snapshots from when each comment was saved; verify them against the current files.',
    ...notes.map(n => `\nRepository: ${n.source.root}${n.source.on ? ` (machine: ${n.source.on})` : ''}\n${n.path}:${lineLabel(n)} (${n.side})\nCode snapshot: ${JSON.stringify(n.code)}\nComment: ${n.text}`)].join('\n');
}
export async function deliverComments({ notes, target, space, agents, send }) {
  const agent = agents.find(a => a.address === target && a.space === space);
  if (!agent) throw new Error('Choose a live agent in this space.');
  if (agent.status !== 'idle') throw new Error('The agent must be idle before sending.');
  const message = formatComments(notes);
  if (message.length > 60000) throw new Error('Send fewer comments at once (maximum 60,000 characters).');
  const result = await send(['send', '--if', 'idle', agent.address, message]);
  if (result.code !== 0) throw new Error(result.stderr?.trim() || result.stdout?.trim() || 'The agent did not accept the comments.');
  return result;
}
export const forLine = (notes, context) => context ? forSource(notes, context.source).filter(n=>n.path===context.path && n.line<=context.line && (n.endLine??n.line)>=context.line && n.side===context.side) : [];
// A refresh may replace row objects. Retain the inline editor only at an exact snapshot match.
export function findMatchingRow(rows, context) {
  if (!context) return null;
  return rows.find(row=>{
    const next=contextForRow(row,context.source,context.side);
    return next && next.path===context.path && next.line===context.line && next.side===context.side && next.code===context.code;
  }) ?? null;
}
const sameFile = (a,b) => a && b && a.path===b.path && a.side===b.side && a.source.root===b.source.root && (a.source.on??null)===(b.source.on??null);
export function rangeContext(start,end,contexts) {
  if(!sameFile(start,end))return null;
  const line=Math.min(start.line,end.line), endLine=Math.max(start.line,end.line);
  if(endLine-line>=500)return null;
  const rows=new Map(contexts.filter(c=>sameFile(c,start)).map(c=>[c.line,c.code]));
  const code=[];
  for(let i=line;i<=endLine;i++){if(!rows.has(i))return null;code.push(rows.get(i));}
  return {...start,line,endLine,code:code.join('\n')};
}
export function isOutdated(note,contexts) {
  const current=rangeContext(note,{...note,line:note.endLine??note.line},contexts);
  return !current || current.code!==note.code;
}
export async function sendAndRemove({note,read,write,...delivery}) {
  await deliverComments({...delivery,notes:[note]});
  write(read().filter(n=>n.id!==note.id));
}
export const lineLabel = context => context?.endLine>context?.line ? `${context.line}-${context.endLine}` : String(context?.line??'');
export function selectionForRows(rows,selection,source,side) {
  if(!selection || selection.source.root!==source?.root || (selection.source.on??null)!==(source?.on??null))return null;
  return rangeContext(selection,{...selection,line:selection.endLine??selection.line},rows.map(r=>contextForRow(r,source,side)).filter(Boolean));
}
