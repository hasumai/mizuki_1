<script lang="ts">
  import { onMount } from 'svelte';
  import { defaultLearningItems, learningGroups, type LearningItem, type LearningStatus } from '../../data/analysis-learning';

  const storageKey = 'hasumai-analysis-learning-v1';
  const statuses: { value: LearningStatus; label: string }[] = [
    { value: 'todo', label: '未开始' },
    { value: 'doing', label: '学习中' },
    { value: 'done', label: '已掌握' },
  ];
  let items: LearningItem[] = $state(defaultLearningItems.map(item => ({ ...item })));
  let group = $state('全部');
  let query = $state('');
  let editing = $state<string | null>(null);
  let draftTitle = $state('');
  let draftGoal = $state('');
  let draftNote = $state('');
  let newTitle = $state('');
  let newGroup = $state('SQL');
  let message = $state('');
  let importInput: HTMLInputElement;

  const filtered = $derived(items.filter(item =>
    (group === '全部' || item.group === group) &&
    `${item.title} ${item.goal} ${item.note}`.toLowerCase().includes(query.trim().toLowerCase())
  ));
  const core = $derived(items.filter(item => item.group !== '拓展选学'));
  const done = $derived(core.filter(item => item.status === 'done').length);
  const doing = $derived(core.filter(item => item.status === 'doing').length);
  const percent = $derived(core.length ? Math.round(done / core.length * 100) : 0);

  onMount(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) items = mergeItems(JSON.parse(saved));
    } catch {
      message = '本地记录读取失败，可通过备份文件恢复。';
    }
  });

  function validItem(value: unknown): value is LearningItem {
    if (!value || typeof value !== 'object') return false;
    const item = value as Record<string, unknown>;
    return typeof item.id === 'string' && item.id.length > 0 &&
      typeof item.group === 'string' && typeof item.title === 'string' &&
      typeof item.goal === 'string' && typeof item.note === 'string' &&
      ['todo', 'doing', 'done'].includes(String(item.status));
  }

  function mergeItems(raw: unknown): LearningItem[] {
    if (!Array.isArray(raw) || !raw.every(validItem)) throw new Error('Invalid learning data');
    const saved = new Map(raw.map(item => [item.id, item]));
    const defaults = defaultLearningItems.map(item => saved.get(item.id) ?? item);
    const custom = raw.filter(item => item.custom && !defaultLearningItems.some(base => base.id === item.id));
    return [...defaults, ...custom];
  }

  function save(next: LearningItem[]) {
    items = next;
    try {
      localStorage.setItem(storageKey, JSON.stringify(items));
      message = '';
    } catch {
      message = '浏览器未能保存记录，请导出备份。';
    }
  }

  function setStatus(id: string, status: LearningStatus) {
    save(items.map(item => item.id === id ? { ...item, status } : item));
  }

  function startEdit(item: LearningItem) {
    editing = item.id;
    draftTitle = item.title;
    draftGoal = item.goal;
    draftNote = item.note;
  }

  function finishEdit(item: LearningItem) {
    if (!draftTitle.trim()) return;
    save(items.map(current => current.id === item.id ? {
      ...current, title: draftTitle.trim(), goal: draftGoal.trim(), note: draftNote.trim()
    } : current));
    editing = null;
  }

  function addItem() {
    if (!newTitle.trim()) return;
    save([...items, {
      id: crypto.randomUUID(), group: newGroup, title: newTitle.trim(), goal: '',
      status: 'todo', note: '', custom: true
    }]);
    newTitle = '';
  }

  function removeItem(id: string) {
    if (!confirm('删除这条自定义学习项？')) return;
    save(items.filter(item => item.id !== id));
  }

  function exportData() {
    const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), items }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'data-analysis-learning.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function importData(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const next = mergeItems(data.items);
      if (!confirm('导入会替换当前浏览器中的学习进度，继续吗？')) return;
      save(next);
      message = '已导入学习记录。';
    } catch {
      message = '文件格式不正确，请选择本页面导出的 JSON 备份。';
    } finally {
      input.value = '';
    }
  }
</script>

<section class="learning" aria-label="数据分析成长">
  <div class="learning-head">
    <div>
      <p class="eyebrow">PERSONAL LEARNING</p>
      <h2>数据分析成长</h2>
      <p class="subline">主线掌握 {done}/{core.length} · 学习中 {doing} · 可按自己的基础随时调整</p>
    </div>
    <div class="overall"><strong>{percent}%</strong><span>主线完成度</span></div>
  </div>
  <div class="progress" role="progressbar" aria-valuenow={percent} aria-valuemin="0" aria-valuemax="100" aria-label="主线完成度"><span style:width={`${percent}%`}></span></div>

  <div class="group-progress">
    {#each learningGroups.filter(name => name !== '拓展选学') as name}
      {@const entries = items.filter(item => item.group === name)}
      {@const count = entries.filter(item => item.status === 'done').length}
      <button class:active={group === name} onclick={() => group = group === name ? '全部' : name}>
        <span>{name}</span><b>{count}/{entries.length}</b>
        <i style:width={`${entries.length ? count / entries.length * 100 : 0}%`}></i>
      </button>
    {/each}
  </div>

  <div class="toolbar">
    <div class="filters">
      <label for="learning-group" class="sr-only">学习分类</label>
      <select id="learning-group" bind:value={group}><option>全部</option>{#each learningGroups as name}<option>{name}</option>{/each}</select>
      <label for="learning-search" class="sr-only">搜索学习项</label>
      <input id="learning-search" placeholder="搜索学习项" bind:value={query} />
    </div>
    <div class="actions">
      <button onclick={exportData} title="下载学习记录备份">导出</button>
      <button onclick={() => importInput.click()} title="从备份恢复学习记录">导入</button>
      <input class="hidden" type="file" accept="application/json,.json" bind:this={importInput} onchange={importData} aria-label="选择学习记录备份" />
    </div>
  </div>

  {#if message}<p class="message" role="status">{message}</p>{/if}
  <div class="item-list">
    {#each filtered as item (item.id)}
      <article class:completed={item.status === 'done'}>
        <div class="item-main">
          <div class="item-title"><span class="group-label">{item.group}</span><h3>{item.title}</h3></div>
          {#if editing === item.id}
            <div class="edit-fields">
              <label>名称<input bind:value={draftTitle} maxlength="80" /></label>
              <label>完成标准<input bind:value={draftGoal} maxlength="240" /></label>
              <label>我的记录<textarea bind:value={draftNote} rows="2" maxlength="1000"></textarea></label>
              <div class="edit-actions"><button onclick={() => finishEdit(item)}>保存</button><button onclick={() => editing = null}>取消</button>{#if item.custom}<button class="danger" onclick={() => removeItem(item.id)}>删除</button>{/if}</div>
            </div>
          {:else}
            <p class="goal">{item.goal || '尚未填写完成标准'}</p>
            {#if item.note}<p class="note">{item.note}</p>{/if}
          {/if}
        </div>
        <div class="item-controls">
          <label class="sr-only" for={`status-${item.id}`}>{item.title}掌握状态</label>
          <select id={`status-${item.id}`} value={item.status} onchange={(event) => setStatus(item.id, event.currentTarget.value as LearningStatus)}>
            {#each statuses as status}<option value={status.value}>{status.label}</option>{/each}
          </select>
          <button class="edit-button" title={`编辑${item.title}`} aria-label={`编辑${item.title}`} onclick={() => startEdit(item)}>✎</button>
        </div>
      </article>
    {:else}
      <p class="empty">没有匹配的学习项。</p>
    {/each}
  </div>

  <form class="add-item" onsubmit={(event) => { event.preventDefault(); addItem(); }}>
    <label for="new-learning-item">新增学习项</label>
    <div><input id="new-learning-item" placeholder="写下你想补充的能力" bind:value={newTitle} maxlength="80" required /><select bind:value={newGroup} aria-label="新增学习项分类">{#each learningGroups as name}<option>{name}</option>{/each}</select><button type="submit">添加</button></div>
  </form>
  <p class="storage-note">记录仅保存在当前浏览器。换设备或清除浏览器数据前，请导出备份。</p>
</section>

<style>
  .learning { margin-bottom: 2rem; padding: 1.35rem; border: 1px solid rgba(255,255,255,.85); border-radius: 8px; background: rgba(255,255,255,.74); backdrop-filter: blur(16px) saturate(130%); -webkit-backdrop-filter: blur(16px) saturate(130%); box-shadow: inset 0 1px 0 rgba(255,255,255,.92), 0 12px 30px rgba(65,37,59,.11); color: inherit; }
  :global(.dark) .learning { border-color: rgba(255,255,255,.19); background: rgba(26,26,35,.74); box-shadow: inset 0 1px 0 rgba(255,255,255,.14), 0 12px 30px rgba(0,0,0,.22); }
  .learning-head { display:flex; justify-content:space-between; align-items:center; gap:1rem; }
  .eyebrow { font-size:.7rem; font-weight:750; color:var(--primary); }
  h2 { font-size:1.45rem; font-weight:750; margin:.15rem 0; }
  .subline,.storage-note,.goal { opacity:.68; font-size:.86rem; }
  .overall { display:flex; flex-direction:column; text-align:right; flex-shrink:0; }
  .overall strong { font-size:1.8rem; line-height:1.1; color:var(--primary); }
  .overall span { font-size:.72rem; opacity:.62; }
  .progress { height:7px; border-radius:4px; margin:1rem 0 1.25rem; background:color-mix(in srgb, var(--primary) 16%, transparent); overflow:hidden; }
  .progress span { display:block; height:100%; background:var(--primary); transition:width .25s; }
  .group-progress { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:.5rem; }
  .group-progress button { position:relative; display:flex; justify-content:space-between; gap:.5rem; padding:.65rem .7rem .85rem; text-align:left; border:1px solid rgba(255,255,255,.75); border-radius:5px; overflow:hidden; background:rgba(255,255,255,.43); box-shadow:inset 0 1px 0 rgba(255,255,255,.7); font-size:.78rem; }
  :global(.dark) .group-progress button { border-color:rgba(255,255,255,.12); background:rgba(255,255,255,.05); box-shadow:inset 0 1px 0 rgba(255,255,255,.09); }
  .group-progress button.active { border-color:var(--primary); }
  .group-progress b { flex-shrink:0; font-size:.75rem; }
  .group-progress i { position:absolute; bottom:0; left:0; height:3px; background:var(--primary); }
  .toolbar { display:flex; justify-content:space-between; gap:.7rem; margin:1.2rem 0 .7rem; }
  .filters,.actions { display:flex; gap:.5rem; }
  input,select,textarea,.actions button,.add-item button,.edit-actions button,.edit-button { border:1px solid var(--line-divider); border-radius:5px; padding:.48rem .65rem; background:var(--card-bg); color:inherit; font-size:.83rem; }
  .filters input { min-width:0; width:12rem; }
  button { cursor:pointer; }
  button:hover { color:var(--primary); }
  .item-list { max-height:33rem; overflow:auto; border-top:1px solid var(--line-divider); }
  article { display:flex; justify-content:space-between; gap:1rem; padding:.8rem .15rem; border-bottom:1px solid var(--line-divider); }
  .item-main { min-width:0; flex:1; }
  .item-title { display:flex; align-items:baseline; gap:.55rem; }
  .group-label { flex-shrink:0; font-size:.68rem; color:var(--primary); }
  h3 { font-weight:650; font-size:.92rem; }
  .goal { margin-top:.15rem; }
  .note { margin-top:.3rem; font-size:.8rem; white-space:pre-wrap; overflow-wrap:anywhere; }
  .completed h3 { color:var(--primary); }
  .item-controls { display:flex; gap:.35rem; align-items:flex-start; flex-shrink:0; }
  .edit-button { width:2.15rem; height:2.15rem; padding:0; font-size:1rem; }
  .edit-fields { display:grid; gap:.5rem; margin-top:.6rem; }
  .edit-fields label { display:grid; gap:.2rem; font-size:.75rem; }
  .edit-fields input,.edit-fields textarea { width:100%; }
  .edit-actions { display:flex; gap:.4rem; }
  .danger { color:#b42318 !important; }
  .add-item { margin-top:1rem; }
  .add-item label { display:block; font-weight:650; font-size:.85rem; margin-bottom:.45rem; }
  .add-item div { display:flex; gap:.5rem; }
  .add-item input { flex:1; min-width:0; }
  .storage-note { margin-top:1rem; font-size:.73rem; }
  .message { color:#b42318; font-size:.82rem; margin:.5rem 0; }
  .empty { padding:1rem; opacity:.65; }
  .hidden,.sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
  @media(max-width:650px) { .learning { padding:1rem; } .group-progress { grid-template-columns:repeat(2,minmax(0,1fr)); } .toolbar { flex-wrap:wrap; } .filters { width:100%; } .filters input { flex:1; } article { flex-wrap:wrap; } .item-controls { width:100%; justify-content:flex-end; } .add-item div { flex-wrap:wrap; } .add-item input { flex-basis:100%; } }
</style>
