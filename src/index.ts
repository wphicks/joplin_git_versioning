import joplin from 'api';
import { ContentScriptType, ToolbarButtonLocation, MenuItemLocation } from 'api/types';
import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';

async function ensureDirExists(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'note';
}

async function runCmd(cmd: string, args: string[], cwd: string): Promise<{ code: number, stdout: string, stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, shell: process.platform === 'win32' });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => out += d.toString());
    child.stderr.on('data', (d) => err += d.toString());
    child.on('close', (code) => resolve({ code: code ?? -1, stdout: out, stderr: err }));
  });
}

async function saveCurrentNoteMarkdown(targetDir: string): Promise<{ filePath: string, noteTitle: string }> {
  const note = await joplin.workspace.selectedNote();
  if (!note) throw new Error('No selected note.');
  const title = note.title || 'Untitled';
  const body = note.body || '';

  await ensureDirExists(targetDir);
  const fileName = `${slugify(title)}.md`;
  const filePath = path.join(targetDir, fileName);

  await fs.writeFile(filePath, body, { encoding: 'utf8' });
  return { filePath, noteTitle: title };
}

async function gitCommitAndPush(repoDir: string, message: string): Promise<string> {
  // best-effort: git init if missing
  const status = await runCmd('git', ['rev-parse', '--is-inside-work-tree'], repoDir);
  if (status.code !== 0) {
    await runCmd('git', ['init'], repoDir);
  }

  // add everything in repoDir
  const addRes = await runCmd('git', ['add', '-A'], repoDir);
  if (addRes.code !== 0) throw new Error(`git add failed: ${addRes.stderr}`);

  // commit; if no changes, this will fail; handle gracefully
  const commitRes = await runCmd('git', ['commit', '-m', message], repoDir);
  const noChange =
    commitRes.code !== 0 &&
    /nothing to commit|no changes added/i.test(commitRes.stderr + commitRes.stdout);

  // try push regardless only if the repo has a remote set
  const remoteRes = await runCmd('git', ['remote'], repoDir);
  if (remoteRes.code === 0 && remoteRes.stdout.trim().length > 0) {
    const pushRes = await runCmd('git', ['push'], repoDir);
    if (pushRes.code !== 0) {
      // surface push errors but keep log
      throw new Error(`git push failed: ${pushRes.stderr || pushRes.stdout}`);
    }
  }

  if (noChange) return 'Committed: no (nothing to commit). Pushed if remote existed.';
  if (commitRes.code !== 0) throw new Error(`git commit failed: ${commitRes.stderr || commitRes.stdout}`);
  return 'Committed and pushed.';
}

async function folderPathSegments(folderId: string): Promise<string[]> {
  const segs: string[] = [];
  let id: string | null = folderId || null;
  while (id) {
    const f = await joplin.data.get(['folders', id]);
    if (!f) break;
    segs.push(f.title || 'untitled');
    id = f.parent_id || null;
  }
  return segs.reverse();
}

async function resolveExportDirForCurrentNote(): Promise<string> {
  const note = await joplin.workspace.selectedNote();
  if (!note) throw new Error('No selected note.');
  const globalDir = String(await joplin.settings.value('targetDir') || '');
  const raw = String(await joplin.settings.value('notebookDirMap') || '{}');
  let m: Record<string,string> = {};
  try { m = JSON.parse(raw) || {}; } catch { /* ignore */ }
  if (!m[note.parent_id]) {
    if (!globalDir){
      return '';
    }
    return path.join(globalDir, ...(await folderPathSegments(note.parent_id)));
  }
  return m[note.parent_id];
}

async function doPipeline() {
  const targetDir = await resolveExportDirForCurrentNote();
  if (!targetDir) throw new Error('No export directory. Configure global or per-notebook.');
  if (!targetDir) throw new Error('Set the Export Directory in the plugin settings.');
  const commitPrefix: string = await joplin.settings.value('commitPrefix');

  const { filePath, noteTitle } = await saveCurrentNoteMarkdown(targetDir);
  const msg = `${commitPrefix}${noteTitle}`;
  const res = await gitCommitAndPush(targetDir, msg);

  await joplin.commands.execute('synchronize'); // built-in command id

  /* await joplin.views.dialogs.showMessageBox(
    `Exported:\n${filePath}\n\nGit:\n${res}`
  ); */
}

async function setDirForCurrentNotebook() {
  const note = await joplin.workspace.selectedNote();
  if (!note) throw new Error('Select a note first.');
  const folderId = note.parent_id;
  const folder = await joplin.data.get(['folders', folderId]);
  const dlg = await joplin.views.dialogs.create('setNotebookDir');
  await joplin.views.dialogs.setHtml(dlg, `
    <form name="f">
      <p>Notebook: <code>${folder.title}</code></p>
      <p>Directory path (absolute): <input name="dir" type="text" style="width: 100%"/></p>
    </form>
  `);
  await joplin.views.dialogs.setButtons(dlg, [{ id: 'ok' }, { id: 'cancel' }]);
  const res = await joplin.views.dialogs.open(dlg);
  if (res.id !== 'ok') return;

  const dir = (res.formData?.f?.dir || '').trim();
  if (!dir) throw new Error('No directory provided.');

  const raw = String(await joplin.settings.value('notebookDirMap') || '{}');
  const map = (() => { try { return JSON.parse(raw) || {}; } catch { return {}; } })();
  map[folderId] = dir;
  await joplin.settings.setValue('notebookDirMap', JSON.stringify(map));
}

async function clearDirForCurrentNotebook() {
  const note = await joplin.workspace.selectedNote();
  if (!note) throw new Error('Select a note first.');
  const folderId = note.parent_id;
  const folder = await joplin.data.get(['folders', folderId]);

  const raw = String(await joplin.settings.value('notebookDirMap') || '{}');
  const map = (() => { try { return JSON.parse(raw) || {}; } catch { return {}; } })();
  if (map[folderId]) {
    delete map[folderId];
    await joplin.settings.setValue('notebookDirMap', JSON.stringify(map));
    await joplin.views.dialogs.showMessageBox(`Cleared export dir for "${folder.title}".`);
  } else {
    await joplin.views.dialogs.showMessageBox(`No per-notebook dir set for "${folder.title}".`);
  }
}

joplin.plugins.register({
  onStart: async function () {
    // Settings
    await joplin.settings.registerSection('exportGitSection', {
      label: 'Git Versioning',
      iconName: 'fas fa-file-export',
    });

    await joplin.settings.registerSettings({
      targetDir: {
        value: '',
        type: 2, // SettingItemType.String
        section: 'exportGitSection',
        public: true,
        label: 'Export Directory (must be a git repo or will be inited)',
        description: 'Example: /home/user/notes-repo',
      },
      commitPrefix: {
        value: 'Automatic Joplin commit: ',
        type: 2,
        section: 'exportGitSection',
        public: true,
        label: 'Commit message prefix',
      },
      notebookDirMap: {
        value: '{}', // JSON: { "<folderId>": "/path/to/dir", ... }
        type: 2,
        section: 'exportGitSection',
        public: true,
        label: 'Per-notebook export directories (JSON map)',
        description: 'Advanced. Example: {"<notebookId>": "/repo/notes/subdir"}'
      }
    });

    // Command
    await joplin.commands.register({
      name: 'setExportDirForNotebook',
      label: 'Set export directory for this notebook',
      execute: () => setDirForCurrentNotebook(),
    });
    await joplin.commands.register({
      name: 'clearExportDirForNotebook',
      label: 'Clear export directory for this notebook',
      execute: () => clearDirForCurrentNotebook(),
    });
    await joplin.commands.register({
      name: 'exportGitSyncCommand',
      label: 'Commit current note',
      execute: async () => {
        try {
          await doPipeline();
        } catch (err: any) {
          await joplin.views.dialogs.showMessageBox(`Error: ${err.message ?? String(err)}`);
        }
      },
    });
    await joplin.views.menuItems.create(
      'exportGitSyncMenuItem',
      'exportGitSyncCommand',
      MenuItemLocation.Tools
    );
  },
});
