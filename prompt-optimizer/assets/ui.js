/**
 * dsh-prompt-optimizer —— 浏览器侧 UI。
 *
 * 形态说明：这是一个**自包含的普通脚本**，由宿主插件通过 `webServer.register`
 * 以 `/dsh-prompt-optimizer/ui.js` 原样吐出，并由 `webServer.tapIndex` 注入到
 * index.html。之所以不用 DSH 的客户端插件打包链路，是因为那需要 tsdown 与其
 * 未发布的 `clientBundle` 预设（官方 README 明说出树插件必须自行复刻构建），
 * 而本仓库要求零构建依赖 —— 这与本机既有第三方插件 dsh-whale-widget 的做法一致。
 *
 * 按需求，本文件保持为**纯 ASCII 源码**：所有中文界面文案都写成 `\uXXXX` 转义，
 * 这样即使服务器以错误的编码返回脚本，界面文字也不会乱码。
 *
 * 职责：
 *   [H] composer 挂载探测
 *   [I] 主按钮 + 上拉菜单（模式切换 / 优化模型 / 预设 / 优化并发送）
 *   [J] 预览确认弹窗（sendStrategy === 'preview'）
 *   [K] 轮次「已优化」标记与「优化后 / 原文」切换
 *   [L] 设置区注入
 */
;(function () {
  'use strict'

  if (window.__dshPromptOptimizer) return
  window.__dshPromptOptimizer = true

  var PREFIX = '/dsh-prompt-optimizer'

  // —— 界面文案（ASCII 源码，中文用转义） ——
  var T = {
    trigger: '\u63d0\u793a\u8bcd\u4f18\u5316', // 提示词优化
    modeDirect: '\u76f4\u63a5\u8f93\u51fa', // 直接输出
    modeOptimize: '\u4f18\u5316\u8f93\u51fa', // 优化输出
    titleMode: '\u8f93\u51fa\u6a21\u5f0f', // 输出模式
    titleModel: '\u4f18\u5316\u6a21\u578b', // 优化模型
    titlePreset: '\u9884\u8bbe', // 预设
    optimizeAndSend: '\u4f18\u5316\u5e76\u53d1\u9001', // 优化并发送
    openSettings: '\u6253\u5f00\u8bbe\u7f6e', // 打开设置
    optimizing: '\u4f18\u5316\u4e2d\u2026', // 优化中…
    optimized: '\u5df2\u4f18\u5316', // 已优化
    showOriginal: '\u67e5\u770b\u539f\u6587', // 查看原文
    showOptimized: '\u770b\u4f18\u5316\u540e', // 看优化后
    cancel: '\u53d6\u6d88', // 取消
    confirmSend: '\u786e\u8ba4\u53d1\u9001', // 确认发送
    previewTitle: '\u4f18\u5316\u540e\u7684\u63d0\u793a\u8bcd', // 优化后的提示词
    previewHint:
      '\u53ef\u4ee5\u76f4\u63a5\u4fee\u6539\u4e0b\u65b9\u5185\u5bb9\uff0c\u786e\u8ba4\u540e\u4f1a\u4ee5\u4fee\u6539\u540e\u7684\u5185\u5bb9\u53d1\u9001\u3002', // 可以直接修改下方内容，确认后会以修改后的内容发送。
    emptyInput: '\u8f93\u5165\u6846\u4e3a\u7a7a', // 输入框为空
    failed: '\u4f18\u5316\u5931\u8d25', // 优化失败
    sendOriginal: '\u5df2\u6539\u4e3a\u53d1\u9001\u539f\u6587', // 已改为发送原文
    settingsTitle: '\u63d0\u793a\u8bcd\u4f18\u5316\u8bbe\u7f6e', // 提示词优化设置
    enabled: '\u542f\u7528\u63d2\u4ef6', // 启用插件
    sendStrategy: '\u53d1\u9001\u65b9\u5f0f', // 发送方式
    strategyAuto: '\u9759\u9ed8\u76f4\u53d1', // 静默直发
    strategyPreview: '\u9884\u89c8\u786e\u8ba4', // 预览确认
    maxTurns: '\u4e0a\u4e0b\u6587\u6700\u591a\u56de\u6eaf\u8f6e\u6570', // 上下文最多回溯轮数
    includeAssistant: '\u4e0a\u4e0b\u6587\u5305\u542b\u52a9\u624b\u8f93\u51fa', // 上下文包含助手输出
    onFailure: '\u5931\u8d25\u65f6', // 失败时
    failOriginal: '\u53d1\u9001\u539f\u6587', // 发送原文
    failCancel: '\u53d6\u6d88\u53d1\u9001', // 取消发送
    instruction: '\u5de5\u4f5c\u8bf4\u660e', // 工作说明
    save: '\u4fdd\u5b58', // 保存
    saved: '\u5df2\u4fdd\u5b58', // 已保存
    saveFailed: '\u4fdd\u5b58\u5931\u8d25', // 保存失败
    loading: '\u52a0\u8f7d\u4e2d\u2026', // 加载中…
    noKey: '\u672a\u914d\u7f6e\u5bc6\u94a5', // 未配置密钥
    unsupported: '\u4e0d\u652f\u6301', // 不支持
    back: '\u8fd4\u56de', // 返回
    refresh: '\u5237\u65b0', // 刷新
    name: '\u540d\u79f0', // 名称
    addPreset: '\u65b0\u589e\u9884\u8bbe', // 新增预设
    newPresetName: '\u65b0\u9884\u8bbe', // 新预设
    deletePreset: '\u5220\u9664', // 删除
    deleteBuiltinWarn:
      '\u8fd9\u662f\u5185\u7f6e\u9884\u8bbe\uff0c\u4e0d\u53ef\u5220\u9664\uff08\u5185\u5bb9\u53ef\u4ee5\u968f\u610f\u4fee\u6539\uff09\u3002\u4ec5\u4ece\u672c\u6b21\u5217\u8868\u4e2d\u79fb\u9664\uff1f', // 这是内置预设，不可删除（内容可以随意修改）。仅从本次列表中移除？
    instructionPlaceholder:
      '\u8fd9\u91cc\u586b\u5199\u4f18\u5316\u6a21\u578b\u7684\u5de5\u4f5c\u8bf4\u660e\uff08\u5373 system \u6307\u4ee4\uff09', // 这里填写优化模型的工作说明（即 system 指令）
  }

  var MODE_LABEL = { direct: T.modeDirect, optimize: T.modeOptimize }
  var STRATEGY_LABEL = { auto: T.strategyAuto, preview: T.strategyPreview }
  var FAILURE_LABEL = { 'send-original': T.failOriginal, cancel: T.failCancel, notify: T.failOriginal }

  /** 当前配置（来自 /config.json）。 */
  var config = null
  /** 模型目录。 */
  var catalog = { groups: [], defaultModelRef: '', available: false }
  /** 当前生效的模型引用。 */
  var effectiveModelRef = ''
  /** 是否正在优化。 */
  var busy = false
  /** 菜单与弹窗元素。 */
  var els = {}
  /** 每个已优化轮次的原始文本缓存：messageKey -> originalText */
  var originalCache = Object.create(null)

  // ==========================================================================
  // 基础设施
  // ==========================================================================

  /**
   * 同源 JSON 请求。
   * @param {string} url - 路径。
   * @param {object} [init] - fetch 选项。
   * @returns {Promise<object>} 解析后的响应体。
   */
  function api(url, init) {
    return fetch(PREFIX + url, {
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      ...(init || {}),
    }).then(function (res) {
      return res.text().then(function (text) {
        var parsed
        try {
          parsed = JSON.parse(text)
        } catch (err) {
          throw new Error('HTTP ' + res.status + ': ' + text.slice(0, 160))
        }
        if (!res.ok && parsed && parsed.error) return parsed
        return parsed
      })
    })
  }

  /** 创建元素。 */
  function el(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = text
    return node
  }

  /** 统一设置 busy 状态。 */
  function setBusy(next) {
    busy = next
    window.__dshPromptOptimizerBusy = next
    if (els.trigger) {
      els.trigger.classList.toggle('dshpo-busy', next)
      els.trigger.textContent = next ? T.optimizing : T.trigger
    }
    if (els.menu) {
      for (var i = 0; i < els.menu.querySelectorAll('button').length; i++) {
        els.menu.querySelectorAll('button')[i].disabled = next
      }
    }
  }

  /** 轻提示。 */
  function toast(message, kind) {
    try {
      var node = el('div', 'dshpo-toast' + (kind ? ' dshpo-toast-' + kind : ''), message)
      document.body.appendChild(node)
      setTimeout(function () {
        node.classList.add('dshpo-toast-out')
        setTimeout(function () {
          try {
            node.remove()
          } catch (err) {}
        }, 300)
      }, kind === 'error' ? 6000 : 3000)
    } catch (err) {}
  }

  // ==========================================================================
  // 输入框探测与挂载
  // ==========================================================================

  /** 找输入区（新版为 contenteditable，旧版为 textarea）。 */
  function findComposerInput() {
    var root = document.getElementById('root')
    if (!root) return null
    var editable = root.querySelector('[contenteditable="true"]')
    if (editable) return editable
    return root.querySelector('textarea')
  }

  /** 读取输入内容。 */
  function readInput(node) {
    if (!node) return ''
    if (node.tagName === 'TEXTAREA') return node.value || ''
    return node.innerText || node.textContent || ''
  }

  /**
   * 找 composer 的「工具行」：一行里既有权限选择器，也有发送按钮。
   *
   * 官方 InputBar 的结构（自 `dsh-client-ui-conversation/lib/client.js` 的渲染顺序确认）：
   *   <div class="modes">    [权限选择器(accessSelect), conversation.input.plan]  </div>
   *   <div class="trailing"> [conversation.input.right, 模型选择器, 发送按钮]      </div>
   * 两者是同一个 flex 行的直接子元素。
   *
   * 定位方式：从发送按钮往上找，取第一个「直接子元素数量在 2~5 之间」的祖先 ——
   * 这比匹配模糊类名稳健，也不依赖 DSH 的 CSS Module 哈希。
   * @param {Element} input - 输入元素。
   * @returns {Element | null} 工具行元素。
   */
  function findToolbar(input) {
    var send = findSendButton(null, input)
    var node = send ? send.parentElement : null
    for (var depth = 0; depth < 5 && node; depth++) {
      if (node === document.body) break
      var kids = node.children.length
      if (kids >= 2 && kids <= 5) return node
      node = node.parentElement
    }
    // 回退：向上找一个矮而宽、且含按钮的容器
    node = input
    for (var d2 = 0; d2 < 4 && node; d2++) {
      node = node.parentElement
      if (!node) break
      var rect = node.getBoundingClientRect()
      if (rect.height > 0 && rect.height < 160 && node.querySelectorAll('button').length > 0) return node
    }
    return input.parentElement || null
  }

  /**
   * 找 composer 卡片（带圆角与描边的输入框外框）—— 仅用于菜单定位。
   * @param {Element} input - 输入元素。
   * @returns {Element | null} 卡片元素。
   */
  function findComposerCard(input) {
    if (!input) return null
    var inputRect = input.getBoundingClientRect()
    var node = input
    for (var depth = 0; depth < 5 && node; depth++) {
      node = node.parentElement
      if (!node || node === document.body) break
      var rect = node.getBoundingClientRect()
      var wideEnough = rect.width >= 120
      var shortEnough = rect.height > 0 && rect.height <= 200
      var containsInput = rect.left <= inputRect.left + 2 && rect.right >= inputRect.right - 2
      if (!(wideEnough && shortEnough && containsInput)) continue
      var looksLikeCard = false
      try {
        var s = window.getComputedStyle(node)
        var bw = parseFloat(s.borderTopWidth) || 0
        var br = parseFloat(s.borderTopLeftRadius) || 0
        var bgOpaque = s.backgroundColor && s.backgroundColor !== 'transparent' && s.backgroundColor !== 'rgba(0, 0, 0, 0)'
        looksLikeCard = bw >= 0.5 || br >= 6 || bgOpaque
      } catch (err) {
        looksLikeCard = false
      }
      if (looksLikeCard) return node
    }
    return null
  }

  /**
   * 在工具行里找权限选择器（用户口中的「权限设置」）。
   *
   * 判据：`aria-label` / `title` 里含「权限」（来自 DSH 中文文案
   * `access.preset.*` 与 `description.permission`），或含对应的英文词。
   * @param {Element} toolbar - 工具行。
   * @returns {Element | null} 权限选择器的直接子容器（插入锚点）。
   */
  function findPermissionControl(toolbar) {
    if (!toolbar) return null
    var candidates = Array.prototype.slice.call(toolbar.querySelectorAll('[aria-label],[title],button'))
    for (var i = 0; i < candidates.length; i++) {
      var node = candidates[i]
      var hay = ((node.getAttribute && node.getAttribute('aria-label')) || '') + ' ' +
        ((node.getAttribute && node.getAttribute('title')) || '') + ' ' +
        (node.textContent || '')
      if (!/权限|permission|access/i.test(hay)) continue
      // 上溯到工具行的直接子元素，作为插入锚点
      var direct = node
      while (direct.parentElement && direct.parentElement !== toolbar) direct = direct.parentElement
      return direct.parentElement === toolbar ? direct : null
    }
    return null
  }

  /**
   * 把主按钮插入工具行 —— 位置就在权限选择器右边、plan 控件左边。
   *
   * 这里**只新增一个节点、不包裹也不移动任何既有节点**，因此：
   *   - 不会改变 DSH 的布局（不会再出现对话框偏移）
   *   - 不会与 React 的协调冲突（不会再打断输入焦点）
   *
   * @param {Element} toolbar - 工具行。
   * @returns {{ ok: boolean, anchor: Element | null }} 插入结果。
   */
  function insertIntoToolbar(toolbar) {
    if (!toolbar) return { ok: false, anchor: null }
    var perm = findPermissionControl(toolbar)
    var anchor = perm ? perm.nextSibling : toolbar.firstChild
    try {
      if (els.trigger.parentElement !== toolbar) toolbar.insertBefore(els.trigger, anchor)
    } catch (err) {
      try {
        toolbar.appendChild(els.trigger)
      } catch (err2) {
        return { ok: false, anchor: null }
      }
    }
    return { ok: true, anchor: perm }
  }

  /**
   * 把上拉菜单定位到 composer 卡片上方（空间不足时翻到下方），并夹在视口内。
   *
   * 菜单挂在 `document.body` 上且不参与文档流，因此**不会推动任何布局**。
   * @param {Element} menu - 菜单元素。
   * @param {Element} anchor - 参照元素（优先用卡片，否则用按钮）。
   */
  function positionMenu(menu, anchor) {
    if (!menu || !anchor || !anchor.getBoundingClientRect) return
    var rect = anchor.getBoundingClientRect()
    var mw = menu.offsetWidth || 300
    var mh = menu.offsetHeight || 320
    var gap = 8
    var left = rect.left
    var top = rect.top - mh - gap
    if (top < 8) {
      var below = rect.bottom + gap
      top = below + mh <= window.innerHeight - 8 ? below : Math.max(8, window.innerHeight - mh - 8)
    }
    if (left + mw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - mw - 8)
    if (left < 8) left = 8
    menu.style.left = left + 'px'
    menu.style.top = top + 'px'
  }

  /**
   * 找到「发送」按钮。
   *
   * **必须排除本插件自己的按钮**，否则 findToolbar 里的「从发送按钮上溯」会以自建按钮为起点，
   * 导致工具行定位错误。
   * @param {Element | null} toolbar - 搜索范围容器（null 时用 document 兜底）。
   * @param {Element | null} input - 输入元素，用于「位于输入框右侧」的判据。
   * @returns {Element | null} 发送按钮。
   */
  function findSendButton(toolbar, input) {
    var scope = toolbar || document
    if (!scope || !scope.querySelectorAll) return null
    var buttons = Array.prototype.slice.call(scope.querySelectorAll('button')).filter(function (b) {
      // 排除本插件自己插入的节点
      return String(b.className || '').indexOf('dshpo-') === -1
    })
    if (buttons.length === 0) return null

    // 判据一：属性里有 send / submit 语义（最可靠，优先）
    var named = buttons.filter(function (b) {
      var hay = ((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '') + ' ' + (b.className || '')).toLowerCase()
      return /send|submit|\u53d1\u9001/.test(hay)
    })
    if (named.length > 0) {
      // 取最靠右的一个（发送按钮通常在行尾）
      named.sort(function (a, b) {
        return a.getBoundingClientRect().left - b.getBoundingClientRect().left
      })
      return named[named.length - 1]
    }

    // 判据二：位于输入框右侧、且不是 disabled 的最后一个按钮
    if (!input) return null
    var inputRect = input.getBoundingClientRect()
    var rightSide = buttons.filter(function (b) {
      var r = b.getBoundingClientRect()
      return r.width > 0 && r.left >= inputRect.right - 8 && !b.disabled
    })
    if (rightSide.length > 0) {
      rightSide.sort(function (a, b) {
        return a.getBoundingClientRect().left - b.getBoundingClientRect().left
      })
      return rightSide[rightSide.length - 1]
    }
    return null
  }

  /**
   * 把优化后的文本写回输入框。
   * @param {Element} input - 输入元素。
   * @param {string} text - 要写入的文本。
   * @returns {boolean} 是否成功。
   */
  function writeInput(input, text) {
    if (!input) return false
    try {
      input.focus()
      if (input.tagName === 'TEXTAREA') {
        var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
        if (setter) setter.call(input, text)
        else input.value = text
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      }
      // contenteditable：走浏览器原生输入路径，保证框架的 input 事件与内部状态同步
      var selection = window.getSelection()
      var range = document.createRange()
      range.selectNodeContents(input)
      selection.removeAllRanges()
      selection.addRange(range)
      var inserted = false
      try {
        inserted = document.execCommand('insertText', false, text)
      } catch (err) {
        inserted = false
      }
      if (!inserted) {
        input.textContent = text
        input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }))
      }
      return true
    } catch (err) {
      return false
    }
  }

  /** 触发发送（点击原生发送按钮）。 */
  function clickSend() {
    var input = findComposerInput()
    if (!input) return false
    var toolbar = findToolbar(input)
    var button = findSendButton(toolbar, input)
    if (!button) return false
    try {
      button.click()
      return true
    } catch (err) {
      return false
    }
  }

  // ==========================================================================
  // 主按钮与上拉菜单
  // ==========================================================================

  /** 构建主按钮。 */
  function buildTrigger() {
    var btn = el('button', 'dshpo-trigger', T.trigger)
    btn.type = 'button'
    btn.title = T.trigger
    btn.addEventListener('click', function (event) {
      event.preventDefault()
      event.stopPropagation()
      toggleMenu()
    })
    return btn
  }

  /** 展开/收起菜单。 */
  function toggleMenu() {
    if (!els.menu) return
    var open = els.menu.classList.toggle('dshpo-menu-open')
    if (!open) return
    renderMenu()
    // 先显示再定位，否则量不到尺寸（display:none 时 offsetWidth 为 0）
    positionMenu(els.menu, menuAnchor())
  }

  /** 关闭菜单。 */
  function closeMenu() {
    if (els.menu) els.menu.classList.remove('dshpo-menu-open')
  }

  /** 把目录压平成选项列表。 */
  function modelOptions() {
    var out = []
    for (var i = 0; i < catalog.groups.length; i++) {
      var group = catalog.groups[i]
      for (var j = 0; j < group.models.length; j++) {
        var model = group.models[j]
        var ref = group.provider + '/' + model.id
        out.push({
          ref: ref,
          label: group.displayName + ' / ' + (model.name || model.id),
          supported: group.supported,
          keyConfigured: group.keyConfigured,
          error: group.error,
        })
      }
    }
    return out
  }

  /** 渲染菜单内容。 */
  function renderMenu() {
    var menu = els.menu
    if (!menu) return
    menu.textContent = ''

    // —— 模式切换 ——
    menu.appendChild(sectionTitle(T.titleMode))
    var modeRow = el('div', 'dshpo-row')
    ;['optimize', 'direct'].forEach(function (mode) {
      var b = el('button', 'dshpo-chip' + (config.mode === mode ? ' dshpo-chip-on' : ''), MODE_LABEL[mode])
      b.type = 'button'
      b.addEventListener('click', function () {
        persist({ mode: mode })
      })
      modeRow.appendChild(b)
    })
    menu.appendChild(modeRow)

    // —— 优化模型 ——
    menu.appendChild(sectionTitle(T.titleModel))
    var options = modelOptions()
    var list = el('div', 'dshpo-list')
    if (options.length === 0) {
      list.appendChild(el('div', 'dshpo-empty', T.loading))
    }
    options.forEach(function (option) {
      var disabled = !option.supported
      var row = el('button', 'dshpo-item' + (effectiveModelRef === option.ref ? ' dshpo-item-on' : '') + (disabled ? ' dshpo-item-off' : ''))
      row.type = 'button'
      row.appendChild(el('span', 'dshpo-item-label', option.label))
      if (disabled) row.appendChild(el('span', 'dshpo-item-note', T.unsupported))
      else if (!option.keyConfigured) row.appendChild(el('span', 'dshpo-item-note', T.noKey))
      if (!disabled) {
        row.addEventListener('click', function () {
          persist({ modelRef: option.ref })
        })
      }
      list.appendChild(row)
    })
    menu.appendChild(list)

    // —— 预设 ——
    menu.appendChild(sectionTitle(T.titlePreset))
    var presetList = el('div', 'dshpo-list')
    ;(config.presets || []).forEach(function (preset) {
      var row = el('button', 'dshpo-item' + (config.presetId === preset.id ? ' dshpo-item-on' : ''))
      row.type = 'button'
      row.appendChild(el('span', 'dshpo-item-label', preset.name || preset.id))
      row.addEventListener('click', function () {
        persist({ presetId: preset.id })
      })
      presetList.appendChild(row)
    })
    menu.appendChild(presetList)

    // —— 动作 ——
    var actions = el('div', 'dshpo-actions')
    var sendBtn = el('button', 'dshpo-primary', T.optimizeAndSend)
    sendBtn.type = 'button'
    sendBtn.addEventListener('click', function () {
      closeMenu()
      optimizeAndSend()
    })
    actions.appendChild(sendBtn)
    var settingsBtn = el('button', 'dshpo-secondary', T.openSettings)
    settingsBtn.type = 'button'
    settingsBtn.addEventListener('click', function () {
      closeMenu()
      openSettingsPanel()
    })
    actions.appendChild(settingsBtn)
    var refreshBtn = el('button', 'dshpo-secondary', T.refresh)
    refreshBtn.type = 'button'
    refreshBtn.addEventListener('click', function () {
      refresh().then(renderMenu)
    })
    actions.appendChild(refreshBtn)
    menu.appendChild(actions)

    // 当前状态摘要
    menu.appendChild(
      el(
        'div',
        'dshpo-meta',
        MODE_LABEL[config.mode] + ' \u00b7 ' + (STRATEGY_LABEL[config.sendStrategy] || '') + ' \u00b7 ' + effectiveModelRef,
      ),
    )
  }

  /** 小节标题。 */
  function sectionTitle(text) {
    return el('div', 'dshpo-section', text)
  }

  // ==========================================================================
  // 配置读写
  // ==========================================================================

  /**
   * 保存局部配置。
   * @param {object} patch - 局部更新。
   */
  function persist(patch) {
    api('/config.json', { method: 'POST', body: JSON.stringify(patch) })
      .then(function (res) {
        if (!res || res.ok !== true) {
          toast((res && res.error) || T.saveFailed, 'error')
          return
        }
        config = res.config
        effectiveModelRef = res.config.modelRef || (activePresetRef() || '')
        renderMenu()
      })
      .catch(function (err) {
        toast(T.saveFailed + ': ' + err.message, 'error')
      })
  }

  /** 当前预设自带的模型引用。 */
  function activePresetRef() {
    var preset = (config.presets || []).filter(function (p) {
      return p.id === config.presetId
    })[0]
    return preset ? preset.modelRef : ''
  }

  /** 重新拉取配置与目录。 */
  function refresh() {
    return api('/config.json')
      .then(function (res) {
        if (!res || res.ok !== true) return
        config = res.config
        catalog = res.catalog || catalog
        effectiveModelRef = res.effectiveModelRef || ''
        updateIndicator()
      })
      .catch(function () {})
  }

  /** 更新按钮上的状态提示。 */
  function updateIndicator() {
    if (!els.trigger || busy) return
    if (!config) return
    els.trigger.classList.toggle('dshpo-on', config.enabled && config.mode === 'optimize')
  }

  // ==========================================================================
  // 优化并发送 / 预览确认
  // ==========================================================================

  /**
   * 调用优化接口。
   * @param {string} prompt - 待优化文本。
   * @param {boolean} issueTicket - 是否签发预览票据。
   * @returns {Promise<object>} 接口响应。
   */
  function callOptimize(prompt, issueTicket) {
    return api('/optimize.json', {
      method: 'POST',
      body: JSON.stringify({ prompt: prompt, issueTicket: issueTicket === true }),
    })
  }

  /** 我的「优化并发送」按钮：无论什么模式都走一次显式优化。 */
  function optimizeAndSend() {
    if (busy) return
    var input = findComposerInput()
    if (!input) {
      toast(T.emptyInput, 'error')
      return
    }
    var text = readInput(input).trim()
    if (text.length === 0) {
      toast(T.emptyInput, 'error')
      return
    }
    if (!config || !config.enabled) {
      toast(T.failed + ': ' + T.enabled, 'error')
      return
    }
    setBusy(true)
    callOptimize(text, true)
      .then(function (res) {
        setBusy(false)
        if (!res || res.ok !== true) {
          toast(T.failed + ': ' + ((res && res.error) || 'unknown'), 'error')
          return
        }
        if (config.sendStrategy === 'preview') {
          showPreview(text, res, input)
          return
        }
        if (writeInput(input, res.optimized)) clickSend()
      })
      .catch(function (err) {
        setBusy(false)
        toast(T.failed + ': ' + err.message, 'error')
      })
  }

  /** 预览确认弹窗。 */
  function showPreview(original, result, input) {
    var mask = el('div', 'dshpo-mask')
    var panel = el('div', 'dshpo-panel')
    panel.appendChild(el('div', 'dshpo-panel-title', T.previewTitle))
    panel.appendChild(el('div', 'dshpo-panel-hint', T.previewHint))

    var area = document.createElement('textarea')
    area.className = 'dshpo-textarea dshpo-textarea-lg'
    area.value = result.optimized
    panel.appendChild(area)

    var meta = el('div', 'dshpo-panel-meta', result.modelRef + ' \u00b7 ' + result.elapsedMs + 'ms')
    panel.appendChild(meta)

    var footer = el('div', 'dshpo-actions')
    var confirm = el('button', 'dshpo-primary', T.confirmSend)
    confirm.type = 'button'
    confirm.addEventListener('click', function () {
      var finalText = area.value
      mask.remove()
      // 票据已按「优化结果」的哈希签发；用户若改过文本，宿主会重新优化一次（行为正确）
      if (writeInput(input, finalText)) clickSend()
    })
    footer.appendChild(confirm)
    var cancel = el('button', 'dshpo-secondary', T.cancel)
    cancel.type = 'button'
    cancel.addEventListener('click', function () {
      mask.remove()
    })
    footer.appendChild(cancel)
    panel.appendChild(footer)

    mask.appendChild(panel)
    mask.addEventListener('click', function (event) {
      if (event.target === mask) mask.remove()
    })
    document.body.appendChild(mask)
    setTimeout(function () {
      area.focus()
      area.setSelectionRange(area.value.length, area.value.length)
    }, 30)
  }

  // ==========================================================================
  // 轮次标记与「优化后 / 原文」切换
  // ==========================================================================

  /** 找会话里所有真人消息的文本节点容器（尽力而为的多重回退）。 */
  function findUserMessageNodes() {
    var root = document.getElementById('root')
    if (!root) return []
    // DSH 的消息节点带 data-* 标记；至少覆盖常见几种写法
    var selectors = [
      '[data-message-role="user"]',
      '[data-role="user"]',
      '[data-message-role="human"]',
      '[data-author="user"]',
    ]
    for (var i = 0; i < selectors.length; i++) {
      var found = root.querySelectorAll(selectors[i])
      if (found.length > 0) return Array.prototype.slice.call(found)
    }
    return []
  }

  /**
   * 给一个消息节点挂「已优化」标记。
   * @param {Element} node - 消息节点。
   * @param {string} original - 原文。
   * @param {string} optimizedBy - 模型引用。
   */
  function decorateNode(node, original, optimizedBy) {
    if (!node || node.querySelector(':scope > .dshpo-badge-wrap')) return
    var wrap = el('div', 'dshpo-badge-wrap')
    var badge = el('button', 'dshpo-badge', T.optimized)
    badge.type = 'button'
    badge.title = optimizedBy || ''
    var showingOriginal = false
    var originalText = original || ''
    var optimizedText = null

    badge.addEventListener('click', function (event) {
      event.preventDefault()
      event.stopPropagation()
      // 找到消息的文本容器：优先 data-* 标注，否则用节点自身
      var target = node.querySelector('[data-message-content]') || node
      if (optimizedText === null) optimizedText = target.innerText
      showingOriginal = !showingOriginal
      var next = showingOriginal ? originalText : optimizedText
      if (next && next.length > 0) target.innerText = next
      badge.textContent = showingOriginal ? T.showOptimized : T.optimized
    })

    wrap.appendChild(badge)
    try {
      node.style.position = node.style.position || 'relative'
      node.appendChild(wrap)
    } catch (err) {}
  }

  /**
   * 扫描会话，补齐标记。
   *
   * 数据来源有两个：
   * 1. 消息来源上的 `po*` 字段（首选；不需要额外请求）
   * 2. 若字段不可用，则退回插件状态接口里的记录（按长度与相邻性启发式匹配）
   */
  function scanMessages() {
    var nodes = findUserMessageNodes()
    if (nodes.length === 0) return
    // 以「节点索引 → 是否已优化」的方式尽力匹配：插件接口提供的 recent 记录不含原文，
    // 因此这里只用 DOM 侧能拿到的信息 —— 若宿主把 po* 字段透传到了前端，
    // 前端脚本可从 window.__dshPromptOptimizerMarks 读取（由本脚本在写入时登记）。
    var marks = window.__dshPromptOptimizerMarks || {}
    var keys = Object.keys(marks)
    if (keys.length === 0) return
    // 从最新一条开始匹配（最近优化的一定在最后）
    var idx = 0
    for (var i = nodes.length - 1; i >= 0 && idx < keys.length; i--) {
      var mark = marks[keys[keys.length - 1 - idx]]
      var text = (nodes[i].innerText || '').trim()
      if (text.length === 0) continue
      if (mark && mark.optimized && text.indexOf(mark.optimized.slice(0, 24)) === 0) {
        decorateNode(nodes[i], mark.original, mark.modelRef)
        idx++
      }
    }
  }

  /** 记录一次本地的「已优化」标记，供 scanMessages 使用。 */
  function recordMark(original, optimized, modelRef) {
    try {
      var marks = window.__dshPromptOptimizerMarks || (window.__dshPromptOptimizerMarks = {})
      marks[String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8)] = {
        original: original,
        optimized: optimized,
        modelRef: modelRef,
      }
      var all = Object.keys(marks)
      if (all.length > 100) delete marks[all[0]]
    } catch (err) {}
  }

  // ==========================================================================
  // 发送拦截（仅预览确认模式需要；静默直发由宿主的 agent/pre-step 完成）
  // ==========================================================================

  /** 是否应当拦截这次发送。 */
  function shouldIntercept() {
    return !!(config && config.enabled && config.mode === 'optimize' && config.sendStrategy === 'preview' && !busy)
  }

  /** 安装发送拦截。 */
  function installSendInterception() {
    // Enter 发送
    document.addEventListener(
      'keydown',
      function (event) {
        if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return
        if (!shouldIntercept()) return
        var target = event.target
        if (!target || !(target.isContentEditable || target.tagName === 'TEXTAREA')) return
        var text = readInput(target).trim()
        if (text.length === 0) return
        event.preventDefault()
        event.stopPropagation()
        interceptSend(text, target)
      },
      true,
    )

    // 点击发送按钮
    document.addEventListener(
      'click',
      function (event) {
        if (!shouldIntercept()) return
        var input = findComposerInput()
        if (!input) return
        var toolbar = findToolbar(input)
        var send = findSendButton(toolbar, input)
        if (!send) return
        var node = event.target
        var hit = false
        while (node && node !== document) {
          if (node === send) {
            hit = true
            break
          }
          node = node.parentNode
        }
        if (!hit) return
        var text = readInput(input).trim()
        if (text.length === 0) return
        event.preventDefault()
        event.stopPropagation()
        interceptSend(text, input)
      },
      true,
    )
  }

  /**
   * 预览确认模式下的发送：先优化，弹窗确认后再真正发送。
   * @param {string} text - 输入文本。
   * @param {Element} input - 输入元素。
   */
  function interceptSend(text, input) {
    setBusy(true)
    callOptimize(text, true)
      .then(function (res) {
        setBusy(false)
        if (!res || res.ok !== true) {
          if (config.onFailure === 'cancel') {
            toast(T.failed + ': ' + ((res && res.error) || 'unknown'), 'error')
            return
          }
          toast(T.failed + ': ' + ((res && res.error) || 'unknown') + ' \u2014 ' + T.sendOriginal, 'error')
          clickSend()
          return
        }
        if (!res.changed) {
          clickSend()
          return
        }
        recordMark(text, res.optimized, res.modelRef)
        showPreview(text, res, input)
      })
      .catch(function (err) {
        setBusy(false)
        toast(T.failed + ': ' + err.message + ' \u2014 ' + T.sendOriginal, 'error')
        clickSend()
      })
  }

  // ==========================================================================
  // 设置区
  // ==========================================================================

  /** 打开独立设置面板（自持，不依赖设置页 DOM 结构）。 */
  function openSettingsPanel() {
    if (!config) {
      toast(T.loading)
      return
    }
    var mask = el('div', 'dshpo-mask dshpo-mask-top')
    var panel = el('div', 'dshpo-panel dshpo-panel-wide')
    panel.appendChild(el('div', 'dshpo-panel-title', T.settingsTitle))

    var body = el('div', 'dshpo-settings')
    var draft = JSON.parse(JSON.stringify(config))

    /** 复选行。 */
    function checkbox(label, get, set) {
      var row = el('label', 'dshpo-field dshpo-field-inline')
      var input = document.createElement('input')
      input.type = 'checkbox'
      input.className = 'dshpo-check'
      input.checked = !!get()
      input.addEventListener('change', function () {
        set(input.checked)
      })
      row.appendChild(input)
      row.appendChild(el('span', null, label))
      return row
    }

    /** 数字行。 */
    function numberField(label, get, set, min, max) {
      var row = el('div', 'dshpo-field')
      row.appendChild(el('label', 'dshpo-label', label))
      var input = document.createElement('input')
      input.type = 'number'
      input.className = 'dshpo-input'
      input.value = String(get())
      input.min = String(min)
      input.max = String(max)
      input.addEventListener('change', function () {
        var n = Number(input.value)
        if (Number.isFinite(n)) set(Math.max(min, Math.min(max, Math.trunc(n))))
      })
      row.appendChild(input)
      return row
    }

    /** 下拉行。 */
    function selectField(label, get, set, options) {
      var row = el('div', 'dshpo-field')
      row.appendChild(el('label', 'dshpo-label', label))
      var select = document.createElement('select')
      select.className = 'dshpo-input'
      options.forEach(function (option) {
        var item = document.createElement('option')
        item.value = option.value
        item.textContent = option.label
        if (option.value === get()) item.selected = true
        select.appendChild(item)
      })
      select.addEventListener('change', function () {
        set(select.value)
      })
      row.appendChild(select)
      return row
    }

    body.appendChild(checkbox(T.enabled, () => draft.enabled, (v) => (draft.enabled = v)))
    body.appendChild(
      selectField(
        T.titleMode,
        () => draft.mode,
        (v) => (draft.mode = v),
        [
          { value: 'optimize', label: T.modeOptimize },
          { value: 'direct', label: T.modeDirect },
        ],
      ),
    )
    body.appendChild(
      selectField(
        T.sendStrategy,
        () => draft.sendStrategy,
        (v) => (draft.sendStrategy = v),
        [
          { value: 'auto', label: T.strategyAuto },
          { value: 'preview', label: T.strategyPreview },
        ],
      ),
    )
    body.appendChild(
      selectField(
        T.onFailure,
        () => draft.onFailure,
        (v) => (draft.onFailure = v),
        [
          { value: 'send-original', label: T.failOriginal },
          { value: 'cancel', label: T.failCancel },
        ],
      ),
    )
    body.appendChild(
      numberField(T.maxTurns, () => draft.context.maxTurns, (v) => (draft.context.maxTurns = v), 0, 200),
    )
    body.appendChild(
      checkbox(T.includeAssistant, () => draft.context.includeAssistant, (v) => (draft.context.includeAssistant = v)),
    )

    // —— 预设编辑（支持新增 / 编辑 / 删除） ——
    body.appendChild(el('div', 'dshpo-section', T.titlePreset))
    var options = modelOptions().filter(function (o) {
      return o.supported
    })
    var presetHost = el('div', 'dshpo-preset-host')
    body.appendChild(presetHost)

    /** 生成一个不与现有预设冲突的新 id。 */
    function newPresetId() {
      var base = 'custom'
      var n = 1
      var taken = {}
      ;(draft.presets || []).forEach(function (p) {
        taken[p.id] = true
      })
      while (taken[base + '-' + n]) n++
      return base + '-' + n
    }

    /** 构建 / 重建某个预设的编辑卡片。 */
    function buildPresetCard(preset) {
      var card = el('div', 'dshpo-card')

      var head = el('div', 'dshpo-card-head')
      head.appendChild(el('div', 'dshpo-card-title', preset.name || preset.id))
      var del = el('button', 'dshpo-danger', T.deletePreset)
      del.type = 'button'
      del.addEventListener('click', function () {
        var warn = preset.builtin ? T.deleteBuiltinWarn : T.deletePreset
        if (!window.confirm(warn)) return
        draft.presets = (draft.presets || []).filter(function (p) {
          return p.id !== preset.id
        })
        if (draft.presetId === preset.id && draft.presets.length > 0) draft.presetId = draft.presets[0].id
        renderPresets()
      })
      head.appendChild(del)
      card.appendChild(head)

      var nameRow = el('div', 'dshpo-field')
      nameRow.appendChild(el('label', 'dshpo-label', T.name))
      var nameInput = document.createElement('input')
      nameInput.className = 'dshpo-input'
      nameInput.value = preset.name || ''
      nameInput.addEventListener('change', function () {
        preset.name = nameInput.value
      })
      nameRow.appendChild(nameInput)
      card.appendChild(nameRow)

      var modelRow = el('div', 'dshpo-field')
      modelRow.appendChild(el('label', 'dshpo-label', T.titleModel))
      var modelSelect = document.createElement('select')
      modelSelect.className = 'dshpo-input'
      var current = preset.modelRef || ''
      var seen = false
      options.forEach(function (option) {
        var item = document.createElement('option')
        item.value = option.ref
        item.textContent = option.label
        if (option.ref === current) {
          item.selected = true
          seen = true
        }
        modelSelect.appendChild(item)
      })
      if (!seen && current) {
        var extra = document.createElement('option')
        extra.value = current
        extra.textContent = current + ' (' + T.unsupported + ')'
        extra.selected = true
        modelSelect.appendChild(extra)
      }
      // 新建预设且模型为空时，默认取目录里的默认模型，避免保存后模型为空无法使用
      if (!current && options.length > 0) {
        preset.modelRef = options[0].ref
        modelSelect.value = options[0].ref
      }
      modelSelect.addEventListener('change', function () {
        preset.modelRef = modelSelect.value
      })
      modelRow.appendChild(modelSelect)
      card.appendChild(modelRow)

      var textRow = el('div', 'dshpo-field')
      textRow.appendChild(el('label', 'dshpo-label', T.instruction))
      var area = document.createElement('textarea')
      area.className = 'dshpo-textarea'
      area.value = preset.instruction || ''
      area.placeholder = T.instructionPlaceholder
      area.addEventListener('change', function () {
        preset.instruction = area.value
      })
      textRow.appendChild(area)
      card.appendChild(textRow)
      return card
    }

    /** 渲染整个预设列表（删除后重绘）。 */
    function renderPresets() {
      presetHost.textContent = ''
      ;(draft.presets || []).forEach(function (preset) {
        presetHost.appendChild(buildPresetCard(preset))
      })
    }
    renderPresets()

    var addRow = el('div', 'dshpo-actions')
    var addBtn = el('button', 'dshpo-secondary', T.addPreset)
    addBtn.type = 'button'
    addBtn.addEventListener('click', function () {
      var preset = {
        id: newPresetId(),
        name: T.newPresetName,
        modelRef: options.length > 0 ? options[0].ref : '',
        instruction: '',
      }
      draft.presets = (draft.presets || []).concat([preset])
      renderPresets()
      // 滚动到新卡片，便于立即编辑
      var cards = presetHost.querySelectorAll('.dshpo-card')
      var last = cards[cards.length - 1]
      if (last && last.scrollIntoView) last.scrollIntoView({ block: 'nearest' })
    })
    addRow.appendChild(addBtn)
    body.appendChild(addRow)

    panel.appendChild(body)

    var footer = el('div', 'dshpo-actions')
    var save = el('button', 'dshpo-primary', T.save)
    save.type = 'button'
    save.addEventListener('click', function () {
      api('/config.json', {
        method: 'POST',
        body: JSON.stringify({
          enabled: draft.enabled,
          mode: draft.mode,
          sendStrategy: draft.sendStrategy,
          onFailure: draft.onFailure,
          context: draft.context,
          presets: draft.presets,
        }),
      })
        .then(function (res) {
          if (!res || res.ok !== true) {
            toast((res && res.error) || T.saveFailed, 'error')
            return
          }
          config = res.config
          effectiveModelRef = res.effectiveModelRef || effectiveModelRef
          updateIndicator()
          toast(T.saved)
          mask.remove()
        })
        .catch(function (err) {
          toast(T.saveFailed + ': ' + err.message, 'error')
        })
    })
    footer.appendChild(save)

    var close = el('button', 'dshpo-secondary', T.cancel)
    close.type = 'button'
    close.addEventListener('click', function () {
      mask.remove()
    })
    footer.appendChild(close)
    panel.appendChild(footer)

    mask.appendChild(panel)
    mask.addEventListener('click', function (event) {
      if (event.target === mask) mask.remove()
    })
    document.body.appendChild(mask)
  }

  // ==========================================================================
  // 样式
  // ==========================================================================

  /**
   * 注入样式。
   *
   * 所有颜色都取自 DSH 的主题 token（前缀 --dsw-），**不得硬编码颜色**：
   * 之前用 #fff 作底色又让文字继承白色，正是深色模式下白底白字看不清的原因。
   * 深色模式的标记是 body[data-ds-dark-theme]，而下列每个 --dsw-alias-* token
   * 都在该标记下被重新定义，因此用 token 就自动同时适配亮色与深色。
   *
   * 已逐个核验存在的 token（每个都在主题包中被定义两次，即亮/暗各一套）：
   *   底色   --dsw-alias-bg-layer-1/2、--dsw-specific-menu、--dsw-alias-bg-overlay
   *   文字   --dsw-alias-label-primary / -secondary / -tertiary、-primary-foreground
   *   描边   --dsw-alias-border-l1 / -l2 / -inverted
   *   交互   --dsw-alias-interactive-bg-hover / -active、--dsw-alias-brand-primary
   *   反馈   --dsw-alias-state-error-primary、--dsw-alias-toast-bg、--dsw-alias-state-warn-primary
   *   阴影   --dsw-elevation-prominent / -panel / -stroke
   */
  function injectStyles() {
    if (document.querySelector('style[data-dshpo]')) return
    var css = [
      /* —— 主按钮：位于工具行内、权限选择器右侧 —— */
      '.dshpo-trigger{flex:0 0 auto;align-self:center;display:inline-flex;align-items:center;gap:4px;',
      'margin:0 4px;padding:4px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-inverted);',
      'background:var(--dsw-alias-button-tool-bar-fill,transparent);color:var(--dsw-alias-label-secondary);',
      'font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap;',
      'transition:background .15s,border-color .15s,color .15s}',
      '.dshpo-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dshpo-trigger.dshpo-on{background:var(--dsw-static-blue-500,#4c8bf5);border-color:transparent;color:#fff}',
      '.dshpo-trigger.dshpo-on:hover{background:var(--dsw-static-blue-600,#3f7ae0);color:#fff}',
      '.dshpo-trigger.dshpo-busy{cursor:progress;opacity:.75}',

      /* —— 上拉菜单：打开时由 JS 指定 fixed 坐标 —— */
      '.dshpo-menu{position:fixed;z-index:2147483000;width:300px;max-height:70vh;overflow:auto;display:none;',
      'flex-direction:column;gap:4px;padding:8px;border-radius:14px;',
      'background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-2,#fff));color:var(--dsw-alias-label-primary);',
      'border:1px solid var(--dsw-alias-border-inverted);',
      'box-shadow:var(--dsw-elevation-prominent,0 8px 28px rgba(0,0,0,.18));font-size:12px}',
      '.dshpo-menu-open{display:flex}',

      /* —— 小节标题 / 模式切换胶囊 —— */
      '.dshpo-section{font-size:11px;color:var(--dsw-alias-label-tertiary);margin:6px 2px 0}',
      '.dshpo-row{display:flex;gap:6px;flex-wrap:wrap}',
      '.dshpo-chip{padding:4px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-inverted);',
      'background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}',
      '.dshpo-chip:hover{color:var(--dsw-alias-label-primary)}',
      '.dshpo-chip-on{background:var(--dsw-static-blue-500,#4c8bf5);border-color:transparent;color:#fff}',
      '.dshpo-chip-on:hover{color:#fff}',

      /* —— 列表项 —— */
      '.dshpo-list{display:flex;flex-direction:column;gap:2px}',
      '.dshpo-item{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:6px 8px;border-radius:8px;',
      'border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-primary);',
      'text-align:left;cursor:pointer;font-size:12px}',
      '.dshpo-item:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshpo-item-on{background:var(--dsw-alias-interactive-bg-active);border-color:var(--dsw-alias-brand-primary)}',
      '.dshpo-item-off{opacity:.45;cursor:not-allowed}',
      '.dshpo-item-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshpo-item-note{flex:0 0 auto;font-size:10px;color:var(--dsw-alias-state-warn-primary)}',
      '.dshpo-empty{padding:6px 8px;color:var(--dsw-alias-label-tertiary)}',

      /* —— 动作按钮 —— */
      '.dshpo-actions{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap}',
      '.dshpo-primary,.dshpo-secondary{padding:6px 12px;border-radius:9px;font-size:12px;cursor:pointer;border:1px solid transparent}',
      '.dshpo-primary{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground)}',
      '.dshpo-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
      '.dshpo-primary:disabled,.dshpo-secondary:disabled{opacity:.5;cursor:not-allowed}',
      '.dshpo-secondary{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);',
      'border-color:var(--dsw-alias-border-inverted)}',
      '.dshpo-secondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}',
      '.dshpo-meta{font-size:10px;color:var(--dsw-alias-label-tertiary);margin-top:4px;word-break:break-all}',

      /* —— 轻提示 —— */
      '.dshpo-toast{position:fixed;right:18px;bottom:18px;z-index:2147483600;max-width:min(520px,80vw);padding:9px 13px;',
      'border-radius:10px;background:var(--dsw-alias-toast-bg,#333);color:#fff;font-size:12px;',
      'box-shadow:var(--dsw-elevation-prominent,0 6px 24px rgba(0,0,0,.3));transition:opacity .3s}',
      '.dshpo-toast-error{background:var(--dsw-alias-state-error-primary);color:#fff}',
      '.dshpo-toast-out{opacity:0}',

      /* —— 弹窗 —— */
      '.dshpo-mask{position:fixed;inset:0;z-index:2147483500;display:flex;align-items:center;justify-content:center;',
      'background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.45));padding:24px}',
      '.dshpo-mask-top{z-index:2147483600}',
      '.dshpo-panel{width:min(720px,92vw);max-height:86vh;overflow:auto;display:flex;flex-direction:column;gap:8px;padding:16px;',
      'border-radius:16px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary);',
      'border:1px solid var(--dsw-alias-border-inverted);',
      'box-shadow:var(--dsw-elevation-prominent,0 12px 40px rgba(0,0,0,.3));font-size:13px}',
      '.dshpo-panel-wide{width:min(880px,94vw)}',
      '.dshpo-panel-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dshpo-panel-hint,.dshpo-panel-meta{font-size:11px;color:var(--dsw-alias-label-tertiary)}',

      /* —— 表单 —— */
      '.dshpo-field{display:flex;flex-direction:column;gap:3px;margin:2px 0}',
      '.dshpo-field-inline{flex-direction:row;align-items:center;gap:6px}',
      '.dshpo-label{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dshpo-input,.dshpo-textarea{width:100%;box-sizing:border-box;padding:6px 8px;border-radius:8px;font-size:12px;',
      'border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-alias-bg-overlay,transparent);',
      'color:var(--dsw-alias-label-primary);font-family:inherit}',
      '.dshpo-input:focus,.dshpo-textarea:focus{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:0}',
      '.dshpo-textarea{min-height:70px;resize:vertical}',
      '.dshpo-textarea-lg{min-height:170px}',
      '.dshpo-card{border:1px solid var(--dsw-alias-border-inverted);border-radius:10px;padding:10px;margin:4px 0;',
      'display:flex;flex-direction:column;gap:4px;background:var(--dsw-alias-bg-layer-1,transparent)}',
      '.dshpo-card-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dshpo-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.dshpo-preset-host{display:flex;flex-direction:column}',
      '.dshpo-danger{padding:3px 10px;border-radius:8px;font-size:11px;cursor:pointer;',
      'border:1px solid var(--dsw-alias-border-inverted);background:transparent;',
      'color:var(--dsw-alias-state-error-primary)}',
      '.dshpo-danger:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshpo-check{accent-color:var(--dsw-static-blue-500,#4c8bf5)}',

      /* —— 轮次标记 —— */
      '.dshpo-badge-wrap{display:flex;justify-content:flex-end;margin-top:2px}',
      '.dshpo-badge{padding:1px 8px;border-radius:999px;font-size:10px;cursor:pointer;',
      'border:1px solid transparent;background:var(--dsw-static-blue-500,#4c8bf5);color:#fff}',
      '.dshpo-badge:hover{background:var(--dsw-static-blue-600,#3f7ae0)}',
    ].join('')
    var style = document.createElement('style')
    style.setAttribute('data-dshpo', '1')
    style.textContent = css
    document.head.appendChild(style)
  }

  // ==========================================================================
  // 启动
  // ==========================================================================

  /**
   * 挂载到 composer 的工具行里，位置在权限选择器右边。
   *
   * 关键设计：**只新增节点，绝不包裹或移动任何既有节点**。
   * 早期版本把 composer 卡片包进一个新建的 flex 行里，结果同时造成两个问题：
   * 布局偏移（多了一层），以及 React 重建那棵子树时把正在输入的 contenteditable 一并重建，
   * 于是输入被打断。现在改为把按钮作为工具行的 flex 子项插入，两个问题同时消除。
   * @returns {boolean} 是否已挂载（或已挂载过）。
   */
  function mount() {
    var input = findComposerInput()
    if (!input) return false

    var toolbar = findToolbar(input)
    if (!toolbar) return false

    injectStyles()

    if (!els.trigger) els.trigger = buildTrigger()
    if (!els.menu) {
      els.menu = el('div', 'dshpo-menu')
      els.menu.addEventListener('click', function (event) {
        event.stopPropagation()
      })
      // 菜单挂到 body 并用 fixed 坐标定位：不参与文档流，因此不会推动任何布局，
      // 也不会被 composer 的 overflow 裁掉。
      document.body.appendChild(els.menu)
      document.addEventListener('click', function (event) {
        if (!els.menu || !els.trigger) return
        if (els.menu.contains(event.target) || els.trigger.contains(event.target)) return
        closeMenu()
      })
      window.addEventListener('resize', function () {
        if (els.menu.classList.contains('dshpo-menu-open')) positionMenu(els.menu, menuAnchor())
      })
      window.addEventListener(
        'scroll',
        function () {
          if (els.menu.classList.contains('dshpo-menu-open')) positionMenu(els.menu, menuAnchor())
        },
        true,
      )
    }

    var placed = insertIntoToolbar(toolbar)
    if (!placed.ok) return false
    updateIndicator()
    return true
  }

  /** 菜单定位的参照元素：优先用 composer 卡片，退化到按钮自身。 */
  function menuAnchor() {
    var input = findComposerInput()
    if (input) {
      var card = findComposerCard(input)
      if (card) return card
    }
    return els.trigger
  }

  /**
   * 巡检：宿主 React 重建 DOM 后我们插入的按钮可能被移除 —— 这里把它补回来。
   *
   * 只在按钮确实不在工具行里时才动作；不会触碰其它任何节点，
   * 因此不会与宿主渲染打架，也不会影响输入焦点。
   */
  function ensureMounted() {
    if (!els.trigger) return
    if (document.contains(els.trigger) && els.trigger.parentElement && els.trigger.parentElement.children.length >= 1) {
      // 仍在文档里且父节点正常：进一步确认父节点确实还是工具行
      var input0 = findComposerInput()
      if (input0) {
        var tb0 = findToolbar(input0)
        if (tb0 && els.trigger.parentElement === tb0) return
      }
    }
    var input = findComposerInput()
    if (!input) return
    var toolbar = findToolbar(input)
    if (!toolbar) return
    insertIntoToolbar(toolbar)
  }

  /** 启动：等待输入区出现（DSH 是异步挂载的 SPA）。 */
  function boot() {
    var tries = 0
    var timer = setInterval(function () {
      tries++
      var ok = false
      try {
        ok = mount()
      } catch (err) {
        ok = false
      }
      if (ok) {
        clearInterval(timer)
        installSendInterception()
        window.__dshPromptOptimizerMenu = { open: toggleMenu, close: closeMenu }
        window.__dshPromptOptimizerSettings = openSettingsPanel
        window.__dshPromptOptimizerRecordMark = recordMark
        return
      }
      if (tries >= 400) clearInterval(timer)
    }, 300)

    // 定期刷新状态、扫描标记、以及把被宿主重建掉的按钮补回来（只在确实丢失时动作）
    setInterval(function () {
      if (!config) {
        refresh()
        return
      }
      try {
        ensureMounted()
      } catch (err) {}
      try {
        scanMessages()
      } catch (err) {}
    }, 5000)

    void refresh()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()
