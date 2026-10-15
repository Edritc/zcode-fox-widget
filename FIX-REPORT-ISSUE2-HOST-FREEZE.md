# 修复报告：点角色后宿主 ZCode 停止刷新画面（issue #2 症状一）

> 写给主项目 AI（发版负责人）。2026-10-14 由桌面浮层排查会话生成。
> 最初按「报告不入库」处理，其后本报告与 `OVERLAY-PAUSE-FINDINGS.md` 随 v1.12.0 一并入库。
> **本修复当时已提交但未发版**（版本号保持 v1.11.1、未打 tag、未发 Release）；随后随 v1.12.0 发布。

## 30 秒摘要

- **解决了什么**：桌面浮层形态下，agent 流式输出进行中把指针压到角色上点击 → **宿主 ZCode 画面停在旧帧**（点一下 ZCode 才恢复）。即 issue #2 的第一个症状，`OVERLAY-PAUSE-FINDINGS.md` 调查的问题。已真机 A/B 实锤修复，并通过日常使用验收。
- **怎么解决的**：一行修复——浮层窗口创建加 `type: 'toolbar'`（仅 win32），让窗口从创建起常驻 `WS_EX_TOOLWINDOW`，从而**永远不进宿主 Chromium 的遮挡判定**。
- **你要做的**：下次发版时把这版带上（版本号建议 v1.11.2，`CHANGELOG.md` 已备好「未发布」条目，改个标题即可），tag/Release/cache 同步照常流程。**绝对不要删掉 `type: 'toolbar'`**（原因见下）。

## 问题机制（闭环链路，全部实测确证）

1. 点击角色 → 页面请求接管鼠标 → Electron `setIgnoreMouseEvents(false)` 会**摘掉**窗口的 `WS_EX_TRANSPARENT|WS_EX_LAYERED`。
2. 此刻浮层 = 铺满工作区 + screen-saver 级置顶 + **没有 `WS_EX_TOOLWINDOW`**（实测 Electron 44.4.5 的 `skipTaskbar:true` 走 ITaskbarList，不再落这个样式位）。
3. → 满足宿主 ZCode 自己的 Chromium 遮挡判定 `IsWindowVisibleAndFullyOpaque` 的「完全不透明遮挡源」谓词（ZCode 3.15.3 = Electron 41.0.3 / Chromium 146.0.7680.80，谓词与 134 逐条核对一致）。
4. → 宿主判定自己「被完全遮挡」→ **停止向屏幕出帧**。浮层进程里的 `disable-features=CalculateNativeWinOcclusion` 只作用于浮层自己，管不到宿主——这就是此前在本浮层进程里怎么加开关都没用的原因。
5. 交还穿透后**不会自动恢复**：样式变化不触发遮挡重算，要等一次前台/位置类 WinEvent——对应「点一下 ZCode 才恢复」。

## 修复

`desktop/main.cjs` 窗口创建处：

```js
...(process.platform === 'win32' ? { type: 'toolbar' } : {}),
```

Electron 对 `type:'toolbar'` 的窗口**创建即设 `WS_EX_TOOLWINDOW`，且穿透/接管/`setFocusable` 键盘焦点各态全程保留**（真机逐态采样验证）。该样式位在 Chromium 遮挡谓词里被直接排除 → 浮层任何模式下都不构成宿主的遮挡源。

附带收益：历史上「点菜单文本框后浮层在任务栏冒幽灵按钮」（`setFocusable(true)` 重写样式冲掉 TOOLWINDOW）也从源头修掉；`follow-window.ps1` 的 `EnsureToolWindow` 跨进程补写保留为安全网。

## 验证证据

- **真机 A/B**（2026-10-14 09:08–09:10，同机同流式任务，唯一变量=跨进程 `SetWindowLongW` 增删该样式位；探针=GDI 全窗截图 blake2b 哈希，88ms/帧，**完全被动采样**）：
  - 无 TOOLWINDOW：基线 34/34 帧变化 → 点击后 113 帧仅 8 个不同、最长静止 ≈8.5s（**冻结**）
  - 有 TOOLWINDOW：基线 34/34 → 点击后 113/113 帧全变（**不冻结**）
- **修复上机核验**：重启浮层后，穿透态样式实测 `NOACTIVATE|TOPMOST|TRANSPARENT|LAYERED|TOOLWINDOW`（0x082800A8）。
- **验收**：日常使用（含流式输出中点击角色）测试完毕，一切正常。
- **自检**：干净 HEAD + 本修复 = `tools/selftest.mjs` 285/285 全绿。

## 复现方法学的两个坑（后来者别再踩）

1. **触发场景**：冻结只在宿主有内容持续输出（流式）时出现；宿主空闲时点击不触发。
2. **检测方式**：冻结检测必须完全被动（鼠标停住不给输入）。检测期间摆动鼠标会用悬停高亮的重绘掩盖冻结 → 假阴性。

## 历史包袱澄清（重要）

- 2026-10-13 晚曾落过同一修复并报「真机无效」后回滚——**那是误判**：插件实际注册运行的是 `~/.zcode/cli/plugins/cache/zcode-fox-local/zcode-fox-widget/1.0.0`（directory 安装快照，hook 的 `${ZCODE_PLUGIN_ROOT}` 与 autostart 都指向它），当时修复只写进了 marketplaces 源目录，**从未同步到 cache**，用户测的是无修复代码。我已手动把 `desktop/main.cjs`/`CHANGELOG.md`/`OVERLAY-PAUSE-FINDINGS.md` 同步到 cache 副本（diff 核验一致），你发版后记得走标准 `git archive` 同步流程覆盖。
- 更早两次无效尝试（接管看门狗、周期出帧去 moveTop）确实无效，与本次修复不冲突，详见 `OVERLAY-PAUSE-FINDINGS.md` 第四节。
- `lib/cli.mjs`、`lib/server.mjs`、`lib/service.mjs`、`lib/update.mjs` 当前工作区的未提交改动**属于你的会话（更新/重启逻辑加固），我没有动它们**，也未包含在本提交里。注意：当前工作区跑 `tools/selftest.mjs` 会挂 1 项「账本状态机：换 key 整本归档」——已在干净 HEAD 验证过，那是 WIP lib 改动引入的，与本修复无关，你收尾时处理。

## 提交信息

- 提交内容：`desktop/main.cjs`（修复+注释）、`CHANGELOG.md`（「未发布」条目）。
- 入库情况：本报告与 `OVERLAY-PAUSE-FINDINGS.md`（含闭环附录）已随 v1.12.0 入库。
- 发版清单（已在 v1.12.0 执行）：版本号（清单 + marketplace，health 同源）→ CHANGELOG 小节 → tag → Release → `git archive HEAD | tar -x -C <cache 副本>` → 重启服务/浮层。
