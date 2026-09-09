/* No network requests, dynamic HTML, or model content execution. */
const vscode = acquireVsCodeApi();
for (const id of ['run', 'model', 'report', 'undo']) {
  document.getElementById(id).addEventListener('click', () => vscode.postMessage({ type: id }));
}
window.addEventListener('message', ({ data }) => {
  if (!data || data.type !== 'state') return;
  document.getElementById('stage').textContent = data.stage;
  document.getElementById('detail').textContent = data.detail;
  document.getElementById('run').disabled = data.busy;
  document.getElementById('model').disabled = data.busy;
  document.getElementById('report').disabled = !data.hasReport;
  document.getElementById('undo').disabled = data.busy || !data.canUndo;
});
vscode.postMessage({ type: 'ready' });