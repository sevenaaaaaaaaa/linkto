/**
 * Apple 备忘录（JXA）脚本生成：所有用户数据经 JSON.stringify 注入为一个字面量，不拼接进代码。
 * 纯函数，可单测（脚本内容与注入安全）；执行在 service 里用 execFile('osascript', ['-l', 'JavaScript', '-e', script])。
 */

export interface NotesPayload {
  title: string
  /** 备忘录正文 HTML（已消毒） */
  html: string
  /** 目标文件夹名；空 = 默认账户的默认文件夹 */
  folder?: string | null
}

/** JSON 字面量：额外转义 U+2028 / U+2029 与 </，保证在任何 JS 上下文里都是一个完整的字符串字面量 */
export function jsLiteral(v: unknown): string {
  return JSON.stringify(v)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
    .replace(/<\//g, '<\\/')
}

export function buildNotesJxa(p: NotesPayload): string {
  const data = jsLiteral({ title: String(p.title ?? ''), html: String(p.html ?? ''), folder: p.folder ? String(p.folder) : '' })
  return `(function () {
  var p = ${data};
  var Notes = Application('Notes');
  var acc = Notes.defaultAccount();
  var folder = null;
  if (p.folder) {
    var hits = acc.folders.whose({ name: p.folder });
    if (hits.length > 0) folder = hits[0];
    else {
      folder = Notes.Folder({ name: p.folder });
      acc.folders.push(folder);
      folder = acc.folders.whose({ name: p.folder })[0];
    }
  } else {
    folder = acc.defaultFolder ? acc.defaultFolder() : acc.folders[0];
  }
  var note = Notes.Note({ name: p.title, body: p.html });
  folder.notes.push(note);
  return 'ok';
})();`
}

/** osascript 错误 → 中文提示 */
export function notesErrorText(stderr: string): string {
  const s = String(stderr ?? '')
  if (/-1743|not authori[sz]ed|不允许|未获得授权/i.test(s))
    return '没有控制「备忘录」的权限：打开 系统设置 → 隐私与安全性 → 自动化 → LinkTo，勾选「备忘录」后重试'
  if (/-600|isn.t running|not running/i.test(s)) return '备忘录没能启动，请手动打开一次「备忘录」再试'
  if (/-1728|Can.t get/i.test(s)) return '找不到备忘录账户或文件夹，检查设置里的文件夹名'
  return `写入备忘录失败：${s.trim().slice(0, 200) || '未知错误'}`
}
