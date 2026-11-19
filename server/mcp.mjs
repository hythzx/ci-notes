import { StoreError } from './core/errors.mjs';

/**
 * MCP 端点（Streamable HTTP JSON-RPC）。
 *
 * handleMcp(req, res, store, rawBody) 处理一次请求：
 *   POST   JSON-RPC 消息（Accept 含 text/event-stream 时以 SSE 单消息响应）
 *   GET    SSE 心跳流（25s comment，本服务不主动推送业务消息）
 *   DELETE 结束会话（204）
 *
 * 鉴权先于一切协议处理：x-cinotes-key 头或 Authorization: Bearer（跳过网关
 * 塞入的 eyJ 开头 JWT）→ store.findMcpKey；命中后 touchMcpKey 刷新 last_used_at。
 * 另校验 Origin（防 DNS 重绑定）与 MCP-Protocol-Version 头。
 */

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'ci-notes', title: '词间笔记', version: '1.0.0' };

const INSTRUCTIONS =
  '这是「词间笔记」——存放古典诗词、随笔与阅读札记的个人书房，词作、意象、典故三个库互相关联。\n' +
  '录入词作用 create_work；写札记用 create_note / update_note；意象用 create_imagery 建条目、' +
  'link_imagery 记录具体用法；典故用 create_allusion 建条目、link_allusion 记录具体解读。\n' +
  '重要原则：\n' +
  '一、札记正文是用户自己的文字。不要代写、不要补写用户没写的段落，用户给了什么就记什么。\n' +
  '二、定稿或已发布的札记不能就地改，系统会自动派生新草稿并保留原稿；恢复历史版本同样生成新草稿。\n' +
  '三、典故的释义（explanation）是通用解释；具体到某首作品的解读，记在 link_allusion 的 ' +
  'interpretation 里，不要写进通用释义。意象同理，具体用法记在 link_imagery。\n' +
  '四、遇到保存冲突时，把两版内容都读给用户听，由用户决定保留哪一版，不要自己挑一个覆盖。';

/* ------------------------------------------------------------------ */
/* 工具定义（34 个，输入 schema 从简但完整）                            */
/* ------------------------------------------------------------------ */

const STR = (description) => ({ type: 'string', description });
const STRS = (description) => ({ type: 'array', items: { type: 'string' }, description });
const OBJS = (description) => ({ type: 'array', items: { type: 'object' }, description });

const CITATION_PROPS = {
  book: STR('书名'), edition: STR('版本'), page: STR('页码'),
  url: STR('网址'), note: STR('备注'), verified: STR('verified / pending / personal'),
};
const CLAIM_PROPS = {
  text: STR('资料内容'),
  kind: STR('verified=已核实资料，pending=待核实信息，personal=个人理解'),
  citations: { type: 'array', items: { type: 'object', properties: CITATION_PROPS } },
};

const TOOLS = [
  /* ---------------- 词作 ---------------- */
  {
    name: 'list_works',
    description: '列出词间里的词作。可按作者、词牌、主题、体裁筛选，或用 q 搜标题与原文。返回词作摘要列表。',
    inputSchema: {
      type: 'object',
      properties: {
        q: STR('在标题与原文中搜索的关键词'),
        author: STR('作者，如「柳永」'),
        cipai: STR('词牌，如「浣溪沙」'),
        tag: STR('主题标签，如「思乡」'),
        kind: STR('体裁：ci（词）或 poem（诗）'),
      },
    },
  },
  {
    name: 'get_work',
    description: '读取一首词作的完整资料：原文、背景、主题标签、引用出处，以及关联的札记。',
    inputSchema: { type: 'object', properties: { id: STR('词作 ID') }, required: ['id'] },
  },
  {
    name: 'create_work',
    description: '录入一首新的词作。词牌可以留空（诗、词均可收录）。背景与引用出处请如实填写；把握不大的资料标 verified="pending"。',
    inputSchema: {
      type: 'object',
      properties: {
        title: STR('标题'),
        author: STR('作者'),
        dynasty: STR('朝代'),
        cipai: STR('词牌，可留空'),
        kind: STR('ci（词）或 poem（诗），默认 ci'),
        content: STR('原文'),
        background: STR('简短背景'),
        tags: STRS('主题标签'),
        claims: { type: 'array', description: '背景、典故等需要标注可信度的资料条目', items: { type: 'object', properties: CLAIM_PROPS } },
        citations: { type: 'array', description: '引用出处列表', items: { type: 'object', properties: CITATION_PROPS } },
        relatedWorkIds: STRS('相关词作 ID 列表'),
      },
      required: ['title'],
    },
  },
  {
    name: 'update_work',
    description: '修改词作资料。会生成新的修改版本，旧版本保留可回看。baseRevision 传当前版本号；冲突时不要自行覆盖。',
    inputSchema: {
      type: 'object',
      properties: {
        id: STR('词作 ID'),
        baseRevision: { type: 'number', description: '当前已知版本号（乐观并发检查）' },
        force: { type: 'boolean', description: '用户确认覆盖时才传 true' },
        title: STR('标题'), author: STR('作者'), dynasty: STR('朝代'),
        cipai: STR('词牌'), kind: STR('体裁'), content: STR('原文'),
        background: STR('简短背景'), tags: STRS('主题标签'),
        claims: OBJS('资料条目'), citations: OBJS('引用出处'),
        relatedWorkIds: STRS('相关词作 ID 列表'),
        changeNote: STR('本次修改说明'),
      },
      required: ['id', 'baseRevision'],
    },
  },
  {
    name: 'delete_work',
    description: '把一首词作移入回收站（可恢复）。不会立即永久删除。',
    inputSchema: { type: 'object', properties: { id: STR('词作 ID') }, required: ['id'] },
  },

  /* ---------------- 札记 ---------------- */
  {
    name: 'list_notes',
    description: '列出词间里的随笔与阅读札记。可按写作状态、发布状态、关联词作筛选，或用 q 搜标题与正文。',
    inputSchema: {
      type: 'object',
      properties: {
        q: STR('在标题与正文中搜索的关键词'),
        writingStatus: STR('idea（构思）/ research（资料收集）/ draft（草稿）/ final（定稿）'),
        publishStatus: STR('unpublished（未发布）/ pending（待发布）/ published（已发布）'),
        workId: STR('只看关联了某首词作的札记'),
        tag: STR('主题标签'),
      },
    },
  },
  {
    name: 'get_note',
    description: '读取一篇札记的完整内容：正文、附记、引用出处、可信度标注、关联词作与写作/发布状态。',
    inputSchema: { type: 'object', properties: { id: STR('札记 ID') }, required: ['id'] },
  },
  {
    name: 'create_note',
    description: '新建一篇随笔或阅读札记。正文写用户自己的文字 —— 不要代写、不要补写用户没写的定稿。写作状态默认 draft。',
    inputSchema: {
      type: 'object',
      properties: {
        title: STR('文章标题'),
        content: STR('随笔正文'),
        note: STR('附记'),
        workIds: STRS('关联的词作 ID 列表，一篇札记可关联多首'),
        tags: STRS('主题标签'),
        writingStatus: STR('idea / research / draft / final，默认 draft'),
        publishStatus: STR('unpublished / pending / published，默认 unpublished'),
        publish: { type: 'object', description: '发布记录', properties: { platform: { type: 'string' }, publishedAt: { type: 'string' }, url: { type: 'string' } } },
        claims: { type: 'array', description: '需要单独标注可信度的资料条目', items: { type: 'object', properties: { ...CLAIM_PROPS, paragraph: { type: 'number', description: '对应正文段落序号' } } } },
        citations: OBJS('引用出处列表'),
      },
      required: ['title'],
    },
  },
  {
    name: 'update_note',
    description: '保存札记的新内容。每次保存生成一个历史版本。定稿或已发布的札记不会被就地改写 —— 会自动派生一份新草稿，原版逐字保留。',
    inputSchema: {
      type: 'object',
      properties: {
        id: STR('札记 ID'),
        baseRevision: { type: 'number', description: '当前已知版本号（乐观并发检查）' },
        force: { type: 'boolean', description: '用户确认覆盖时才传 true' },
        title: STR('标题'), content: STR('新的正文'), note: STR('附记'),
        workIds: STRS('关联的词作 ID 列表'), tags: STRS('主题标签'),
        writingStatus: STR('idea / research / draft / final'),
        publishStatus: STR('unpublished / pending / published'),
        publish: { type: 'object', properties: { platform: { type: 'string' }, publishedAt: { type: 'string' }, url: { type: 'string' } } },
        changeNote: STR('本次修改说明'),
        claims: OBJS('资料条目'), citations: OBJS('引用出处'),
      },
      required: ['id', 'baseRevision'],
    },
  },
  {
    name: 'delete_note',
    description: '把一篇札记移入回收站（可恢复）。不会立即永久删除。',
    inputSchema: { type: 'object', properties: { id: STR('札记 ID') }, required: ['id'] },
  },

  /* ---------------- 版本 ---------------- */
  {
    name: 'list_revisions',
    description: '列出一篇札记的历史版本，含时间与修改说明。',
    inputSchema: { type: 'object', properties: { noteId: STR('札记 ID') }, required: ['noteId'] },
  },
  {
    name: 'compare_revisions',
    description: '比较同一篇札记的两个历史版本，逐行标出新增、删除与修改。',
    inputSchema: {
      type: 'object',
      properties: {
        noteId: STR('札记 ID'),
        a: STR('版本 A 的 ID'),
        b: STR('版本 B 的 ID'),
      },
      required: ['noteId', 'a', 'b'],
    },
  },
  {
    name: 'restore_revision',
    description: '把某个历史版本复制成一份新草稿。原来的版本不会被改动。',
    inputSchema: {
      type: 'object',
      properties: { noteId: STR('札记 ID'), revisionId: STR('历史版本 ID') },
      required: ['noteId', 'revisionId'],
    },
  },

  /* ---------------- 词作对照 ---------------- */
  {
    name: 'list_comparisons',
    description: '列出词间里的词作对照笔记，含标题、关联的两首词作与更新时间。想看某一首词作都跟谁对照过，用这个。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'save_comparison',
    description: '新建或更新一份词作对照笔记。按原文、人物情境、意象、典故、表达方式、相同点、不同点、自己的理解逐维度填写。',
    inputSchema: {
      type: 'object',
      properties: {
        id: STR('要更新的对照笔记 ID，新建时留空'),
        title: STR('标题'),
        workAId: STR('甲侧词作 ID'),
        workBId: STR('乙侧词作 ID'),
        dimensions: {
          type: 'object',
          description: '各维度的内容。context=人物与情境，imagery=意象，allusion=典故及出处，expression=表达方式，similarity=相同点，difference=不同点，understanding=自己的阅读理解',
          properties: {
            context: DIMENSION(), imagery: DIMENSION(), allusion: DIMENSION(),
            expression: DIMENSION(), similarity: DIMENSION(),
            difference: DIMENSION(), understanding: DIMENSION(),
          },
        },
      },
      required: ['workAId', 'workBId'],
    },
  },

  /* ---------------- 意象库 ---------------- */
  {
    name: 'list_imagery',
    description: '列出意象。意象是作品中具体承载情感的事物（月亮、芳草、落花），与主题标签（相思、离别）不同。可按名称、别名、描述搜索。',
    inputSchema: { type: 'object', properties: { q: STR('在名称、别名、描述、札记里搜索'), tag: STR('意象自带的主题标签') } },
  },
  {
    name: 'get_imagery',
    description: '读取一个意象的完整资料：通用介绍、别名、常见用途，以及它在每首作品、每篇札记里的具体用法（对应词句、情境、表达作用、我的理解）。',
    inputSchema: { type: 'object', properties: { id: STR('意象 ID') }, required: ['id'] },
  },
  {
    name: 'create_imagery',
    description: '新建一个意象。介绍是可选的 —— 不要给意象定死含义，具体到每首作品里的用法分别记录在 link_imagery 里。',
    inputSchema: {
      type: 'object',
      properties: {
        name: STR('名称，如：月亮'),
        aliases: STRS('别名或检索词'),
        description: STR('简短描述（可选）'),
        usages: STRS('常见表达用途，可记多种'),
        note: STR('我的阅读札记'),
        tags: STRS('主题标签'),
      },
      required: ['name'],
    },
  },
  {
    name: 'update_imagery',
    description: '修改意象的通用资料。只影响通用介绍，不动任何作品里已写好的具体解读。',
    inputSchema: {
      type: 'object',
      properties: {
        id: STR('意象 ID'),
        baseRevision: { type: 'number', description: '当前已知版本号（乐观并发检查）' },
        name: STR('名称'), aliases: STRS('别名'), description: STR('简短描述'),
        usages: STRS('常见表达用途'), note: STR('我的阅读札记'),
      },
      required: ['id', 'baseRevision'],
    },
  },
  {
    name: 'delete_imagery',
    description: '删除一个意象及其全部使用记录（绝不连带删作品或札记）。返回删除前的关联计数；请先向用户确认再调用。',
    inputSchema: { type: 'object', properties: { id: STR('意象 ID') }, required: ['id'] },
  },
  {
    name: 'link_imagery',
    description: '记录某个意象在一首作品或一篇札记里的具体使用：对应词句、情境、表达作用、我的理解。同一意象在同一作品里出现多处时，分别记多条。',
    inputSchema: {
      type: 'object',
      properties: {
        imageryId: STR('意象 ID'),
        targetType: STR('work（作品）或 note（札记）'),
        targetId: STR('作品或札记的 ID'),
        quote: STR('对应原文或具体词句'),
        context: STR('该处的情境与描述'),
        function: STR('在这件作品中的表达作用'),
        understanding: STR('我的理解'),
      },
      required: ['imageryId', 'targetType', 'targetId'],
    },
  },
  {
    name: 'list_imagery_of',
    description: '列出一首作品或一篇札记关联的全部意象及具体用法。',
    inputSchema: {
      type: 'object',
      properties: { targetType: STR('work 或 note'), targetId: STR('作品或札记的 ID') },
      required: ['targetType', 'targetId'],
    },
  },
  {
    name: 'compare_imagery',
    description: '比较两首作品里共同与各自不同的意象。只依据已经记录过的关联，不作猜测。',
    inputSchema: {
      type: 'object',
      properties: { workAId: STR('甲侧词作 ID'), workBId: STR('乙侧词作 ID') },
      required: ['workAId', 'workBId'],
    },
  },

  /* ---------------- 典故库（与意象对称，表达作用字段为 interpretation） ---------------- */
  {
    name: 'list_allusions',
    description: '列出典故。典故是作品中引用的成事、成句（庄周梦蝶、灞桥折柳）。可按名称、别名、出处搜索。',
    inputSchema: { type: 'object', properties: { q: STR('在名称、别名、出处、原文里搜索'), tag: STR('典故自带的主题标签') } },
  },
  {
    name: 'get_allusion',
    description: '读取一个典故的完整资料：通用释义、出处、原文，以及它在每首作品、每篇札记里的具体用法（对应词句、情境、具体解读、我的理解）。',
    inputSchema: { type: 'object', properties: { id: STR('典故 ID') }, required: ['id'] },
  },
  {
    name: 'create_allusion',
    description: '新建一个典故。explanation 写通用解释即可；具体到某首作品的解读，记在 link_allusion 的 interpretation 里，不要写进通用释义。',
    inputSchema: {
      type: 'object',
      properties: {
        name: STR('名称，如：庄周梦蝶'),
        aliases: STRS('别名或检索词'),
        source: STR('出处，如「庄子·齐物论」'),
        original: STR('原文语句'),
        explanation: STR('通用解释（不是某一首作品里的具体解读）'),
        usages: STRS('常见表达用途，可记多种'),
        note: STR('我的阅读札记'),
        tags: STRS('主题标签'),
        claims: OBJS('资料条目'), citations: OBJS('引用出处'),
      },
      required: ['name'],
    },
  },
  {
    name: 'update_allusion',
    description: '修改典故的通用资料。只影响通用释义，不动任何作品里已写好的具体解读。',
    inputSchema: {
      type: 'object',
      properties: {
        id: STR('典故 ID'),
        baseRevision: { type: 'number', description: '当前已知版本号（乐观并发检查）' },
        name: STR('名称'), aliases: STRS('别名'), source: STR('出处'),
        original: STR('原文语句'), explanation: STR('通用解释'),
        usages: STRS('常见表达用途'), note: STR('我的阅读札记'),
      },
      required: ['id', 'baseRevision'],
    },
  },
  {
    name: 'delete_allusion',
    description: '删除一个典故及其全部使用记录（绝不连带删作品或札记）。返回删除前的关联计数；请先向用户确认再调用。',
    inputSchema: { type: 'object', properties: { id: STR('典故 ID') }, required: ['id'] },
  },
  {
    name: 'link_allusion',
    description: '记录某个典故在一首作品或一篇札记里的具体使用：对应词句、情境、具体解读（interpretation）、我的理解。同一典故在同一作品里出现多处时，分别记多条。',
    inputSchema: {
      type: 'object',
      properties: {
        allusionId: STR('典故 ID'),
        targetType: STR('work（作品）或 note（札记）'),
        targetId: STR('作品或札记的 ID'),
        quote: STR('对应原文或具体词句'),
        context: STR('该处的情境与描述'),
        interpretation: STR('这个典故在这一处的具体解读'),
        understanding: STR('我的理解'),
      },
      required: ['allusionId', 'targetType', 'targetId'],
    },
  },
  {
    name: 'list_allusions_of',
    description: '列出一首作品或一篇札记关联的全部典故及具体用法。',
    inputSchema: {
      type: 'object',
      properties: { targetType: STR('work 或 note'), targetId: STR('作品或札记的 ID') },
      required: ['targetType', 'targetId'],
    },
  },
  {
    name: 'compare_allusions',
    description: '比较两首作品里共同与各自不同的典故。只依据已经记录过的关联，不作猜测。',
    inputSchema: {
      type: 'object',
      properties: { workAId: STR('甲侧词作 ID'), workBId: STR('乙侧词作 ID') },
      required: ['workAId', 'workBId'],
    },
  },

  /* ---------------- 聚合 / 搜索 / 统计 / 备份 ---------------- */
  {
    name: 'search',
    description: '在全部词作与札记里搜索。返回标题、作者与正文片段。',
    inputSchema: { type: 'object', properties: { q: STR('关键词') }, required: ['q'] },
  },
  {
    name: 'get_stats',
    description: '统计当前账号的词作、札记、版本数量与可用的作者、词牌、主题标签列表。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'export_backup',
    description: '导出当前账号的完整备份（JSON 文本），含全部词作、札记、历史版本、引用出处、关联关系与回收站。',
    inputSchema: { type: 'object', properties: {} },
  },
];

/** 对照笔记的维度对象（text + 可信度 + 两侧对照） */
function DIMENSION() {
  return {
    type: 'object',
    properties: {
      text: { type: 'string' },
      kind: { type: 'string', description: 'verified / pending / personal' },
      citations: { type: 'array', items: { type: 'object', properties: CITATION_PROPS } },
      sides: { type: 'object', description: '两侧各自的表述', properties: { a: { type: 'string' }, b: { type: 'string' } } },
    },
  };
}

/* ------------------------------------------------------------------ */
/* 工具实现                                                            */
/* ------------------------------------------------------------------ */

const text = (s) => ({ content: [{ type: 'text', text: String(s ?? '') }] });
const objText = (x) => text(JSON.stringify(x, null, 2));
/** 列表返回文本：条数标题行 + JSON 正文 */
const listText = (label, items) => text(`共 ${items.length} ${label}\n${JSON.stringify(items, null, 2)}`);

/**
 * StoreError → 工具文本。CONFLICT 必须把库中当前版本一并带出去，
 * 并提醒把两版都读给用户听，不要自行挑一个覆盖。
 */
function describeError(e) {
  let msg = `[${e.code}] ${e.message}`;
  if (e.code === 'CONFLICT' && e.current !== undefined) {
    msg += `\n\n当前库中版本：\n${JSON.stringify(e.current, null, 2)}` +
      '\n\n请把两版都读给用户听，由用户决定，不要自己挑一个覆盖。';
  }
  return msg;
}

/** CAS 字段拆分：baseRevision/force 进 opts，其余为 patch */
function casArgs(a) {
  const { baseRevision, force, ...patch } = a;
  const opts = { baseRevision };
  if (force === true) opts.force = true;
  return [patch, opts];
}

const HANDLERS = {
  /* ---------------- 词作 ---------------- */
  list_works(store, a) {
    return listText('首词作', store.listWorks({ q: a.q, author: a.author, cipai: a.cipai, tag: a.tag, kind: a.kind }));
  },
  get_work(store, a) {
    return objText(store.getWork(a.id));
  },
  create_work(store, a) {
    const w = store.createWork(a);
    return text(`已录入词作《${w.title}》，ID：${w.id}`);
  },
  update_work(store, a) {
    const [patch, opts] = casArgs(a);
    const { work } = store.updateWork(a.id, patch, opts);
    return text(`已更新词作《${work.title}》，当前版本 v${work.revision}`);
  },
  delete_work(store, a) {
    store.trashWork(a.id);
    return text('已移入回收站，可以恢复。');
  },

  /* ---------------- 札记 ---------------- */
  list_notes(store, a) {
    return listText('篇札记', store.listNotes({ q: a.q, writingStatus: a.writingStatus, publishStatus: a.publishStatus, workId: a.workId, tag: a.tag }));
  },
  get_note(store, a) {
    return objText(store.getNote(a.id));
  },
  create_note(store, a) {
    const { note } = store.createNote(a);
    return text(`已新建札记《${note.title}》，ID：${note.id}`);
  },
  update_note(store, a) {
    const [patch, opts] = casArgs(a);
    const r = store.saveNote(a.id, patch, opts);
    // 定稿/已发布不被就地改写：原稿逐字保留，另起一份新草稿
    if (r.createdDraft) {
      return text(`原稿未动，新草稿 id=${r.draft.id}（原稿 ID：${r.note.id}）。`);
    }
    return text(`已保存札记《${r.note.title}》，生成版本 v${r.revision.seq}`);
  },
  delete_note(store, a) {
    store.trashNote(a.id);
    return text('已移入回收站，可以恢复。');
  },

  /* ---------------- 版本 ---------------- */
  list_revisions(store, a) {
    return listText('个版本', store.listRevisions(a.noteId));
  },
  compare_revisions(store, a) {
    return objText(store.compareRevisions(a.noteId, a.a, a.b));
  },
  restore_revision(store, a) {
    const { draft } = store.restoreRevision(a.noteId, a.revisionId);
    return text(`已复制为新草稿，ID：${draft.id}`);
  },

  /* ---------------- 词作对照 ---------------- */
  list_comparisons(store) {
    return listText('份对照笔记', store.listComparisons());
  },
  save_comparison(store, a) {
    const c = store.saveComparison(a);
    return text(`已保存对照笔记「${c.title || '未命名'}」，ID：${c.id}`);
  },

  /* ---------------- 意象库 ---------------- */
  list_imagery(store, a) {
    return listText('个意象', store.listImagery({ q: a.q, tag: a.tag }).entries);
  },
  get_imagery(store, a) {
    return objText(store.getImagery(a.id));
  },
  create_imagery(store, a) {
    const m = store.createImagery(a);
    return text(`已新建意象「${m.name}」，ID：${m.id}`);
  },
  update_imagery(store, a) {
    const [patch, opts] = casArgs(a);
    const m = store.updateImagery(a.id, patch, opts);
    return text(`已更新意象「${m.name}」（作品里的具体解读未受影响）`);
  },
  delete_imagery(store, a) {
    const impact = store.imageryImpact(a.id); // 先拼提示文本（含 uses/works/notes 计数）
    store.deleteImagery(a.id);
    return text(`已删除意象，一并删除了 ${impact.uses} 条使用记录` +
      `（涉及作品 ${impact.works} 首、札记 ${impact.notes} 篇）。作品与札记本身未受影响。`);
  },
  link_imagery(store, a) {
    // 工具入参 function 映射到 payload 字段 fn（Task 6 契约）
    store.createImageryUse({
      imageryId: a.imageryId, targetType: a.targetType, targetId: a.targetId,
      quote: a.quote, context: a.context, fn: a.function, understanding: a.understanding,
    });
    return text('已记录这处意象用法');
  },
  list_imagery_of(store, a) {
    return listText('条使用记录', store.listImageryUses({ targetType: a.targetType, targetId: a.targetId }));
  },
  compare_imagery(store, a) {
    return objText(store.compareImagery(a.workAId, a.workBId));
  },

  /* ---------------- 典故库 ---------------- */
  list_allusions(store, a) {
    return listText('个典故', store.listAllusions({ q: a.q, tag: a.tag }).entries);
  },
  get_allusion(store, a) {
    return objText(store.getAllusion(a.id));
  },
  create_allusion(store, a) {
    const al = store.createAllusion(a);
    return text(`已新建典故「${al.name}」，ID：${al.id}`);
  },
  update_allusion(store, a) {
    const [patch, opts] = casArgs(a);
    const al = store.updateAllusion(a.id, patch, opts);
    return text(`已更新典故「${al.name}」（作品里的具体解读未受影响）`);
  },
  delete_allusion(store, a) {
    const impact = store.allusionImpact(a.id); // 先拼提示文本（含 uses/works/notes 计数）
    store.deleteAllusion(a.id);
    return text(`已删除典故，一并删除了 ${impact.uses} 条使用记录` +
      `（涉及作品 ${impact.works} 首、札记 ${impact.notes} 篇）。作品与札记本身未受影响。`);
  },
  link_allusion(store, a) {
    store.createAllusionUse({
      allusionId: a.allusionId, targetType: a.targetType, targetId: a.targetId,
      quote: a.quote, context: a.context, interpretation: a.interpretation, understanding: a.understanding,
    });
    return text('已记录这处典故用法');
  },
  list_allusions_of(store, a) {
    return listText('条使用记录', store.listAllusionUses({ targetType: a.targetType, targetId: a.targetId }));
  },
  compare_allusions(store, a) {
    return objText(store.compareAllusions(a.workAId, a.workBId));
  },

  /* ---------------- 聚合 / 搜索 / 统计 / 备份 ---------------- */
  search(store, a) {
    const r = store.globalSearch(a.q);
    return text(`词作 ${r.works.length} 首、札记 ${r.notes.length} 篇\n${JSON.stringify(r, null, 2)}`);
  },
  get_stats(store) {
    return objText(store.getStats());
  },
  export_backup(store) {
    return objText(store.buildBackup());
  },
};

// 只读工具：list/get/compare 前缀 + search / export_backup（get_stats 由 get_ 前缀覆盖）
const isReadOnly = (name) => /^(list|get|compare)_/.test(name) || name === 'search' || name === 'export_backup';

const toolList = () => TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
  annotations: { readOnlyHint: isReadOnly(t.name) },
}));

/* ------------------------------------------------------------------ */
/* 传输与 JSON-RPC                                                     */
/* ------------------------------------------------------------------ */

const jsonSend = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

/** SSE 帧：一条消息一个 event（单消息后即关闭） */
const sseSend = (res, body) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.end(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
};

/** Accept 含 text/event-stream → SSE 单消息响应，否则 application/json */
const wantsSse = (req) => String(req.headers.accept || '').toLowerCase().includes('text/event-stream');

const respond = (res, req, id, result, error) => {
  const body = error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result };
  return wantsSse(req) ? sseSend(res, body) : jsonSend(res, 200, body);
};

/**
 * 从请求里取密钥：优先 x-cinotes-key（自有头，网关不会改写），
 * 其次 Authorization: Bearer —— 只认非 JWT（eyJ 开头）的值，
 * 免得把分享网关塞进来的会话令牌当成密钥去查库。
 */
function extractKey(req) {
  const custom = req.headers['x-cinotes-key'];
  if (custom) {
    const v = String(custom).trim();
    if (v) return v;
  }
  const auth = req.headers.authorization;
  if (auth && /^Bearer\s+/i.test(auth)) {
    const v = auth.replace(/^Bearer\s+/i, '').trim();
    if (v && !v.startsWith('eyJ')) return v;
  }
  return '';
}

/** tools/call 分发；StoreError → isError 结果（HTTP 200），其余异常 → -32603 */
function runTool(store, name, args) {
  const fn = HANDLERS[name];
  if (!fn) return { error: { code: -32602, message: 'Unknown tool: ' + name } };
  try {
    return { result: fn(store, args || {}) };
  } catch (e) {
    if (e instanceof StoreError) {
      return { result: { content: [{ type: 'text', text: describeError(e) }], isError: true } };
    }
    return { error: { code: -32603, message: (e && e.message) || '内部错误' } };
  }
}

/** GET：SSE 心跳流（25s comment）；本服务不主动推送业务消息，仅保持连接 */
function sseHeartbeat(req, res) {
  if (!wantsSse(req)) {
    return jsonSend(res, 406, { error: { code: 'NOT_ACCEPTABLE', message: 'GET 需要 Accept: text/event-stream' } });
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write(': ci-notes MCP 已连接\n\n');
  // 心跳，避免中间代理掐断空闲连接
  const timer = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(timer); }
  }, 25000);
  res.on('close', () => clearInterval(timer));
}

/**
 * 处理一次 /mcp 请求。rawBody 为 app 层已读取的 POST 请求体原文（≤4MB），
 * GET / DELETE 传 undefined。
 */
export async function handleMcp(req, res, store, rawBody) {
  // Origin 校验（防 DNS 重绑定）：无 Origin 的命令行客户端放行
  if (req.headers.origin) {
    let host = null;
    try { host = new URL(req.headers.origin).host; } catch { host = null; }
    if (!host || host !== req.headers.host) {
      return jsonSend(res, 403, { error: { code: 'FORBIDDEN', message: 'Origin 与主机不一致' } });
    }
  }
  // 协议版本头：存在且不在允许集 → 400
  const proto = req.headers['mcp-protocol-version'];
  if (proto && !SUPPORTED_PROTOCOLS.includes(proto)) {
    return jsonSend(res, 400, { error: { code: 'UNSUPPORTED_PROTOCOL_VERSION', message: '不支持的协议版本：' + proto } });
  }
  // 密钥鉴权：先于一切 JSON-RPC 处理；INVALID 附诊断但不回显完整密钥
  const key = extractKey(req);
  const record = key ? store.findMcpKey(key) : null;
  if (!record) {
    const error = { code: -32001, message: '未提供有效密钥' };
    if (key) error.data = { keyLen: key.length, keyHead: key.slice(0, 6), keyTail: key.slice(-4) };
    return jsonSend(res, 401, { jsonrpc: '2.0', id: null, error });
  }
  store.touchMcpKey(record.id);

  if (req.method === 'GET') return sseHeartbeat(req, res);
  if (req.method === 'DELETE') { res.writeHead(204); return res.end(); }
  if (req.method !== 'POST') { res.writeHead(405, { Allow: 'GET, POST, DELETE' }); return res.end(); }

  let msg;
  try {
    const raw = String(rawBody ?? '');
    if (!raw.trim()) throw new Error('请求体是空的');
    msg = JSON.parse(raw);
  } catch (e) {
    return jsonSend(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: ' + e.message } });
  }

  const id = msg && msg.id;
  const method = msg && msg.method;
  // 通知与响应消息：接受即返回 202，无正文
  if (id === undefined || id === null || msg.result !== undefined || msg.error !== undefined) {
    res.writeHead(202);
    return res.end();
  }

  if (method === 'initialize') {
    return respond(res, req, id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      instructions: INSTRUCTIONS,
    });
  }
  if (method === 'ping') return respond(res, req, id, {});
  if (method === 'tools/list') return respond(res, req, id, { tools: toolList() });
  if (method === 'resources/list') return respond(res, req, id, { resources: [] });
  if (method === 'prompts/list') return respond(res, req, id, { prompts: [] });
  if (method === 'tools/call') {
    const params = msg.params || {};
    const out = runTool(store, params.name, params.arguments);
    return out.error
      ? respond(res, req, id, undefined, out.error)
      : respond(res, req, id, out.result);
  }
  return respond(res, req, id, undefined, { code: -32601, message: 'Method not found: ' + method });
}
