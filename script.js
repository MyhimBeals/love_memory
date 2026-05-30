document.addEventListener('DOMContentLoaded', () => {
    // 1. 设置开始时间：2024年11月13日 00:00:00
    const startDate = new Date('2024-11-13T00:00:00');

    // 2. 计时器逻辑
    function updateTimer() {
        const now = new Date();
        const diff = now - startDate;

        if (diff < 0) {
            return;
        }

        const days = Math.floor(diff / (1000 * 60 * 60 * 24));
        const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((diff % (1000 * 60)) / 1000);

        updateNumber('days', days);
        updateNumber('hours', hours);
        updateNumber('minutes', minutes);
        updateNumber('seconds', seconds);
    }

    // 3. 自动抓取名言 (使用一言 API)
    async function fetchQuote() {
        const quoteText = document.getElementById('quote-text');
        const quoteFrom = document.getElementById('quote-from');

        try {
            const response = await fetch('https://v1.hitokoto.cn/?c=k&c=h&c=i');
            const data = await response.json();

            quoteText.innerText = data.hitokoto;
            quoteFrom.innerText = `—— ${data.from_who || ''} 「${data.from}」`;
        } catch (error) {
            console.error('Fetch quote failed:', error);
            quoteText.innerText = '爱是勇敢者的游戏。';
            quoteFrom.innerText = '—— 佚名';
        }
    }

    // 4. 交互功能：弹窗管理（带入场动画）
    const buttons = {
        bbs: document.getElementById('btn-bbs'),
        secret: document.getElementById('btn-secret'),
        memory: document.getElementById('btn-memory'),
        tryon: document.getElementById('btn-tryon')
    };
    const modals = {
        bbs: document.getElementById('modal-bbs'),
        secret: document.getElementById('modal-secret'),
        memory: document.getElementById('modal-memory'),
        tryon: document.getElementById('modal-tryon')
    };

    function openModal(type) {
        const modal = modals[type];
        modal.style.display = 'flex';
        // 触发入场动画
        requestAnimationFrame(() => {
            modal.classList.add('modal-show');
        });

        if (type === 'bbs') renderBBSMessages();
        if (type === 'secret') {
            document.getElementById('secret-lock').style.display = 'block';
            document.getElementById('secret-content').style.display = 'none';
        }
        if (type === 'memory') {
            document.getElementById('memory-lock').style.display = 'block';
            document.getElementById('memory-content').style.display = 'none';
        }
    }

    function closeAllModals() {
        Object.values(modals).forEach(m => {
            m.classList.remove('modal-show');
            setTimeout(() => {
                m.style.display = 'none';
            }, 400);
        });
    }

    document.querySelectorAll('.close-btn').forEach(btn => {
        btn.onclick = closeAllModals;
    });

    // 点击弹窗外部关闭
    Object.values(modals).forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeAllModals();
        });
    });

    buttons.bbs.onclick = () => openModal('bbs');
    buttons.secret.onclick = () => openModal('secret');
    buttons.memory.onclick = () => openModal('memory');
    buttons.tryon.onclick = () => openModal('tryon');

    // 5. API 基础（自动适配路径前缀，兼容本地和服务器部署）
    const basePath = window.location.pathname.replace(/\/[^/]*$/, '');
    const API_BASE = basePath + '/api';

    // ========================================
    //  数据缓存层（核心优化）
    // ========================================
    const dataCache = {
        messages: null,
        secrets: null,
        memories: null,
        loaded: false,
    };

    // 页面加载时立即预取全部数据
    async function preloadAllData() {
        try {
            const response = await fetch(`${API_BASE}/all`);
            const data = await response.json();
            dataCache.messages = data.messages;
            dataCache.secrets = data.secrets;
            dataCache.memories = data.memories;
            dataCache.loaded = true;
            console.log('[Cache] 数据预加载完成');
        } catch (error) {
            console.warn('[Cache] 预加载失败，将在打开时实时请求', error);
        }
    }
    preloadAllData();

    // ========================================
    //  留言板 — 聊天气泡风格
    // ========================================
    async function renderBBSMessages() {
        const list = document.getElementById('bbs-list');
        const countEl = document.getElementById('bbs-count');

        // 如果缓存有数据，先用缓存立即渲染
        if (dataCache.messages) {
            _renderBBSFromData(list, countEl, dataCache.messages);
            return;
        }

        list.innerHTML = `<div class="loading-state"><div class="loading-dots"><span></span><span></span><span></span></div></div>`;

        try {
            const response = await fetch(`${API_BASE}/messages`);
            const messages = await response.json();
            dataCache.messages = messages;
            _renderBBSFromData(list, countEl, messages);
        } catch (error) {
            console.error('Error fetching messages:', error);
            list.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">😢</div>
                    <div class="empty-text">加载失败，请检查网络连接</div>
                </div>`;
        }
    }

    function _renderBBSFromData(list, countEl, messages) {
        countEl.textContent = messages.length;
        if (messages.length === 0) {
            list.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">💬</div>
                    <div class="empty-text">还没有留言哦，来说点什么吧~</div>
                </div>`;
            return;
        }
        const sorted = [...messages].reverse();
        list.innerHTML = sorted.map(m => `
            <div class="msg-bubble" data-id="${m.id}">
                <span class="bubble-delete" onclick="deleteMessage('bbs', ${m.id})">×</span>
                <div class="bubble-text">${escapeHTML(m.text)}</div>
                <div class="bubble-time">${m.time}</div>
            </div>
        `).join('');
        const body = list.closest('.modal-body');
        if (body) {
            requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
        }
    }

    // ========================================
    //  悄悄话 — 手写信风格
    // ========================================
    async function renderSecretMessages() {
        const list = document.getElementById('secret-list');
        const countEl = document.getElementById('secret-count');

        // 如果缓存有数据，先用缓存立即渲染
        if (dataCache.secrets) {
            _renderSecretsFromData(list, countEl, dataCache.secrets);
            return;
        }

        list.innerHTML = `<div class="loading-state"><div class="loading-dots"><span></span><span></span><span></span></div></div>`;

        try {
            const response = await fetch(`${API_BASE}/secrets`);
            const messages = await response.json();
            dataCache.secrets = messages;
            _renderSecretsFromData(list, countEl, messages);
        } catch (error) {
            console.error('Error fetching secrets:', error);
            list.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">😢</div>
                    <div class="empty-text">加载失败...</div>
                </div>`;
        }
    }

    function _renderSecretsFromData(list, countEl, messages) {
        countEl.textContent = messages.length;
        if (messages.length === 0) {
            list.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">💌</div>
                    <div class="empty-text">写下你们的悄悄话吧~</div>
                </div>`;
            return;
        }
        list.innerHTML = messages.map(m => `
            <div class="secret-note" data-id="${m.id}">
                <div class="note-stripe"></div>
                <span class="note-delete" onclick="deleteMessage('secret', ${m.id})">×</span>
                <div class="note-text">${escapeHTML(m.text)}</div>
                <div class="note-time">${m.time}</div>
            </div>
        `).join('');
    }

    // ========================================
    //  通用消息保存 — 直接插入 DOM，无刷新
    // ========================================
    async function saveMessage(type, text) {
        if (!text.trim()) return;

        const timeStr = new Date().toLocaleString();
        const endpoint = type === 'bbs' ? '/messages' : '/secrets';
        try {
            const response = await fetch(`${API_BASE}${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, time: timeStr })
            });

            if (!response.ok) { console.error('Failed to save message'); return; }

            const result = await response.json();
            const newId = result.id ?? Date.now(); // 后端返回 id 最好，兜底用时间戳
            const newItem = { id: newId, text, time: timeStr };

            // 同步更新缓存
            const cacheKey = type === 'bbs' ? 'messages' : 'secrets';
            if (dataCache[cacheKey]) {
                dataCache[cacheKey].unshift(newItem);
            }

            if (type === 'bbs') {
                const list = document.getElementById('bbs-list');
                const countEl = document.getElementById('bbs-count');

                // 清除空状态
                if (list.querySelector('.empty-state')) list.innerHTML = '';

                // 直接追加到底部
                const div = document.createElement('div');
                div.className = 'msg-bubble';
                div.dataset.id = newId;
                div.innerHTML = `
                    <span class="bubble-delete" onclick="deleteMessage('bbs', ${newId})">×</span>
                    <div class="bubble-text">${escapeHTML(text)}</div>
                    <div class="bubble-time">${timeStr}</div>`;
                list.appendChild(div);

                // 滚动到底部
                const body = list.closest('.modal-body');
                if (body) body.scrollTop = body.scrollHeight;

                // 更新计数
                countEl.textContent = list.querySelectorAll('.msg-bubble').length;

            } else {
                const list = document.getElementById('secret-list');
                const countEl = document.getElementById('secret-count');

                if (list.querySelector('.empty-state')) list.innerHTML = '';

                const div = document.createElement('div');
                div.className = 'secret-note';
                div.dataset.id = newId;
                div.innerHTML = `
                    <div class="note-stripe"></div>
                    <span class="note-delete" onclick="deleteMessage('secret', ${newId})">×</span>
                    <div class="note-text">${escapeHTML(text)}</div>
                    <div class="note-time">${timeStr}</div>`;
                list.prepend(div); // 悄悄话最新在顶部

                countEl.textContent = list.querySelectorAll('.secret-note').length;
            }

        } catch (error) {
            console.error('Error saving message:', error);
        }
    }

    // ========================================
    //  通用消息删除 — 直接移除 DOM，无刷新
    // ========================================
    async function deleteMessage(type, id) {
        if (!confirm('确定要删除这条消息吗？')) return;

        const el = document.querySelector(`[data-id="${id}"]`);
        if (el) el.classList.add('fade-out');

        const endpoint = type === 'bbs' ? '/messages' : '/secrets';
        try {
            const response = await fetch(`${API_BASE}${endpoint}/${id}`, { method: 'DELETE' });

            if (response.ok) {
                // 同步更新缓存
                const cacheKey = type === 'bbs' ? 'messages' : 'secrets';
                if (dataCache[cacheKey]) {
                    dataCache[cacheKey] = dataCache[cacheKey].filter(m => m.id !== id);
                }
                setTimeout(() => {
                    if (el && el.parentNode) el.parentNode.removeChild(el);

                    // 更新计数
                    const listId = type === 'bbs' ? 'bbs-list' : 'secret-list';
                    const countId = type === 'bbs' ? 'bbs-count' : 'secret-count';
                    const itemSel = type === 'bbs' ? '.msg-bubble' : '.secret-note';
                    const list = document.getElementById(listId);
                    const countEl = document.getElementById(countId);
                    const remaining = list.querySelectorAll(itemSel).length;
                    countEl.textContent = remaining;

                    // 如果全删完，显示空状态
                    if (remaining === 0) {
                        const icon = type === 'bbs' ? '💬' : '💌';
                        const txt = type === 'bbs' ? '还没有留言哦，来说点什么吧~' : '写下你们的悄悄话吧~';
                        list.innerHTML = `<div class="empty-state"><div class="empty-icon">${icon}</div><div class="empty-text">${txt}</div></div>`;
                    }
                }, 400);
            } else {
                console.error('Failed to delete message');
                if (el) el.classList.remove('fade-out');
            }
        } catch (error) {
            console.error('Error deleting message:', error);
            if (el) el.classList.remove('fade-out');
        }
    }

    // 通用发送函数
    function setupSend(inputId, sendBtnId, type) {
        const input = document.getElementById(inputId);
        const btn = document.getElementById(sendBtnId);

        const send = () => {
            if (input.value.trim()) {
                saveMessage(type, input.value);
                input.value = '';
            }
        };

        btn.onclick = send;
        input.onkeypress = (e) => {
            if (e.key === 'Enter') send();
        };
    }

    // 绑定发送事件
    setupSend('bbs-input', 'bbs-send', 'bbs');
    setupSend('secret-input', 'secret-send', 'secret');

    // 全局暴露删除函数给 onclick
    window.deleteMessage = deleteMessage;

    // 6. 私密信箱逻辑
    document.getElementById('secret-unlock').onclick = () => {
        const pwd = document.getElementById('secret-pwd').value;
        if (pwd === '0825') {
            document.getElementById('secret-lock').style.display = 'none';
            document.getElementById('secret-content').style.display = 'flex';
            document.getElementById('secret-content').style.flexDirection = 'column';
            document.getElementById('secret-content').style.flex = '1';
            document.getElementById('secret-content').style.overflow = 'hidden';
            renderSecretMessages();
        } else {
            alert('密码错啦，再想想？');
        }
    };

    // 添加重新上锁功能
    document.getElementById('secret-relock').onclick = () => {
        document.getElementById('secret-content').style.display = 'none';
        document.getElementById('secret-lock').style.display = 'block';
        document.getElementById('secret-pwd').value = '';
    };

    // 记忆墙密码锁逻辑
    document.getElementById('memory-unlock').onclick = () => {
        const pwd = document.getElementById('memory-pwd').value;
        if (pwd === '0825') {
            document.getElementById('memory-lock').style.display = 'none';
            document.getElementById('memory-content').style.display = 'block';
            renderMemories();
        } else {
            alert('密码错啦，再想想？');
        }
    };

    document.getElementById('memory-relock').onclick = () => {
        document.getElementById('memory-content').style.display = 'none';
        document.getElementById('memory-lock').style.display = 'block';
        document.getElementById('memory-pwd').value = '';
    };

    // ========================================
    //  记忆墙 — 时间轴布局
    // ========================================
    async function renderMemories() {
        const gallery = document.getElementById('memory-gallery');
        const countEl = document.getElementById('memory-count');

        // 如果缓存有数据，先用缓存立即渲染
        if (dataCache.memories) {
            _renderMemoriesFromData(gallery, countEl, dataCache.memories);
            return;
        }

        gallery.innerHTML = `<div class="loading-state"><div class="loading-dots"><span></span><span></span><span></span></div></div>`;

        try {
            const response = await fetch(`${API_BASE}/memories`);
            const memories = await response.json();
            dataCache.memories = memories;
            _renderMemoriesFromData(gallery, countEl, memories);
        } catch (error) {
            console.error('Error fetching memories:', error);
            gallery.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">😢</div>
                    <div class="empty-text">加载失败...</div>
                </div>`;
        }
    }

    function getMemoryMediaHTML(img) {
        if (!img) return '';
        const isVideo = img.match(/\.(mp4|webm|mov|ogg)$/i);
        const escapedImg = img.replace(/'/g, "\\'");
        if (isVideo) {
            return `
                <div class="card-video-wrap" onclick="openLightbox('${escapedImg}', 'video')">
                    <video src="${img}" class="card-img card-video" preload="metadata" playsinline muted></video>
                    <div class="video-play-btn">
                        <span class="play-icon">▶</span>
                    </div>
                </div>`;
        } else {
            return `
                <div class="card-img-wrap" onclick="openLightbox('${escapedImg}', 'image')">
                    <img src="${img}" class="card-img" loading="lazy">
                </div>`;
        }
    }

    function _renderMemoriesFromData(gallery, countEl, memories) {
        countEl.textContent = memories.length;
        if (memories.length === 0) {
            gallery.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">📷</div>
                    <div class="empty-text">还没有共同记忆，快去上传吧~</div>
                </div>`;
            return;
        }
        gallery.innerHTML = memories.map(m => `
            <div class="timeline-item">
                <div class="timeline-dot"></div>
                <div class="timeline-card" data-id="${m.id}">
                    <span class="card-delete" onclick="event.stopPropagation(); deleteMemory(${m.id})">×</span>
                    ${getMemoryMediaHTML(m.img)}
                    <div class="card-body">
                        ${m.date ? `<div class="card-date">${m.date}</div>` : ''}
                        ${m.content ? `<p class="card-content">${escapeHTML(m.content)}</p>` : ''}
                        ${m.feeling ? `<p class="card-feeling">"${escapeHTML(m.feeling)}"</p>` : ''}
                    </div>
                </div>
            </div>
        `).join('');
    }

    window.deleteMemory = async (id) => {
        if (!confirm('确定要删除这段记忆吗？')) return;

        const card = document.querySelector(`.timeline-card[data-id="${id}"]`);
        const item = card ? card.closest('.timeline-item') : null;
        if (item) item.classList.add('fade-out');

        try {
            const response = await fetch(`${API_BASE}/memories/${id}`, { method: 'DELETE' });

            if (response.ok) {
                // 同步更新缓存
                if (dataCache.memories) {
                    dataCache.memories = dataCache.memories.filter(m => m.id !== id);
                }
                setTimeout(() => {
                    if (item && item.parentNode) item.parentNode.removeChild(item);

                    // 更新计数
                    const gallery = document.getElementById('memory-gallery');
                    const countEl = document.getElementById('memory-count');
                    const remaining = gallery.querySelectorAll('.timeline-item').length;
                    countEl.textContent = remaining;

                    // 全删完显示空状态
                    if (remaining === 0) {
                        gallery.innerHTML = `<div class="empty-state"><div class="empty-icon">📷</div><div class="empty-text">还没有共同记忆，快去上传吧~</div></div>`;
                    }
                }, 400);
            } else {
                console.error('Failed to delete memory');
                if (item) item.classList.remove('fade-out');
            }
        } catch (error) {
            console.error('Error deleting memory:', error);
            if (item) item.classList.remove('fade-out');
        }
    };

    // 图片/视频预览逻辑
    const memoryFileInput = document.getElementById('memory-file');
    const uploadArea = document.getElementById('upload-area');
    const previewImg = document.getElementById('image-preview');
    const uploadText = document.getElementById('upload-text');
    const videoPreviewIndicator = document.getElementById('video-preview-indicator');
    const videoPreviewName = document.getElementById('video-preview-name');

    if (uploadArea && memoryFileInput) {
        uploadArea.onclick = () => memoryFileInput.click();

        memoryFileInput.onchange = (e) => {
            const file = e.target.files[0];
            if (file) {
                if (file.type.startsWith('video/')) {
                    if (previewImg) previewImg.style.display = 'none';
                    if (videoPreviewIndicator) videoPreviewIndicator.style.display = 'block';
                    if (videoPreviewName) videoPreviewName.textContent = file.name;
                    if (uploadText) uploadText.style.display = 'none';
                } else {
                    if (videoPreviewIndicator) videoPreviewIndicator.style.display = 'none';
                    const reader = new FileReader();
                    reader.onload = (e) => {
                        if (previewImg) {
                            previewImg.src = e.target.result;
                            previewImg.style.display = 'block';
                        }
                        if (uploadText) uploadText.style.display = 'none';
                    };
                    reader.readAsDataURL(file);
                }
            }
        };
    }

    document.getElementById('memory-add').onclick = async () => {
        const dateInput = document.getElementById('memory-date');
        const contentInput = document.getElementById('memory-content');
        const feelingInput = document.getElementById('memory-feeling');
        const file = memoryFileInput ? memoryFileInput.files[0] : null;

        const hasDate = dateInput.value;
        const hasContent = contentInput.value.trim();
        const hasFeeling = feelingInput.value.trim();
        const hasFile = !!file;

        if (!hasDate && !hasContent && !hasFeeling && !hasFile) {
            alert('请至少记录一点内容（日期、回忆、感受或照片/视频）哦~');
            return;
        }

        try {
            const formData = new FormData();
            formData.append('date', dateInput.value);
            formData.append('content', contentInput.value.trim());
            formData.append('feeling', feelingInput.value.trim());
            if (file) {
                formData.append('file', file);
            }

            const response = await fetch(`${API_BASE}/memories`, {
                method: 'POST',
                body: formData // 浏览器会自动设定正确的 Content-Type 及 boundary，千万不要手动设置 Headers
            });

            if (response.ok) {
                const result = await response.json();
                const newId = result.id ?? Date.now();
                const localPath = result.img || '';

                const gallery = document.getElementById('memory-gallery');
                const countEl = document.getElementById('memory-count');

                // 清除空状态
                if (gallery.querySelector('.empty-state')) gallery.innerHTML = '';

                // 构建新时间轴节点，插入到顶部（最新在最上方）
                const data = {
                    id: newId,
                    date: dateInput.value,
                    content: contentInput.value.trim(),
                    feeling: feelingInput.value.trim(),
                    img: localPath
                };

                const item = document.createElement('div');
                item.className = 'timeline-item';
                item.innerHTML = `
                    <div class="timeline-dot"></div>
                    <div class="timeline-card" data-id="${data.id}">
                        <span class="card-delete" onclick="event.stopPropagation(); deleteMemory(${data.id})">×</span>
                        ${getMemoryMediaHTML(data.img)}
                        <div class="card-body">
                            ${data.date ? `<div class="card-date">${data.date}</div>` : ''}
                            ${data.content ? `<p class="card-content">${escapeHTML(data.content)}</p>` : ''}
                            ${data.feeling ? `<p class="card-feeling">"${escapeHTML(data.feeling)}"</p>` : ''}
                        </div>
                    </div>`;

                gallery.prepend(item);
                countEl.textContent = gallery.querySelectorAll('.timeline-item').length;

                // 同步更新缓存
                if (dataCache.memories) {
                    dataCache.memories.unshift(data);
                }

                // 重置表单
                dateInput.value = '';
                contentInput.value = '';
                feelingInput.value = '';
                if (memoryFileInput) memoryFileInput.value = '';
                if (previewImg) previewImg.style.display = 'none';
                if (videoPreviewIndicator) videoPreviewIndicator.style.display = 'none';
                if (videoPreviewName) videoPreviewName.textContent = '';
                if (uploadText) uploadText.style.display = 'block';

            } else {
                console.error('Failed to save memory');
                alert('保存失败，请稍后重试');
            }
        } catch (error) {
            console.error('Error saving memory:', error);
            alert('网络错误，保存失败');
        }
    };

    // ========================================
    //  工具函数
    // ========================================
    function escapeHTML(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function updateNumber(id, value) {
        const element = document.getElementById(id);
        const formattedValue = value < 10 ? `0${value}` : value;
        if (element.innerText !== formattedValue.toString()) {
            element.innerText = formattedValue;
        }
    }

    // 初始化
    setInterval(updateTimer, 1000);
    updateTimer();
    fetchQuote();

    // ========================================
    //  装饰层初始化
    // ========================================

    // 悄悄话 — 注入星点层
    (function injectStarsLayer() {
        const secretContent = document.querySelector('#modal-secret .modal-content');
        if (!secretContent) return;
        const layer = document.createElement('div');
        layer.className = 'stars-layer';
        secretContent.prepend(layer);
    })();

    // 记忆墙 — 注入 bokeh 光斑层
    (function injectBokehLayer() {
        const memoryContent = document.querySelector('#modal-memory .modal-content');
        if (!memoryContent) return;

        const layer = document.createElement('div');
        layer.className = 'bokeh-layer';

        // 颜色池：青碧+蓝紫+白
        const colors = [
            'rgba(60,200,200,VAL)',
            'rgba(80,160,255,VAL)',
            'rgba(130,80,220,VAL)',
            'rgba(255,255,255,VAL)',
            'rgba(40,180,160,VAL)',
            'rgba(160,120,255,VAL)',
        ];

        for (let i = 0; i < 18; i++) {
            const dot = document.createElement('div');
            dot.className = 'bokeh-dot';

            const size = 4 + Math.random() * 16;             // 4–20px
            const x = Math.random() * 100;                // 0–100%
            const y = 20 + Math.random() * 70;            // 20–90%
            const dur = 6 + Math.random() * 10;             // 6–16s
            const delay = -Math.random() * 12;                // 随机起点
            const alpha = (0.2 + Math.random() * 0.5).toFixed(2);
            const color = colors[i % colors.length].replace('VAL', alpha);

            Object.assign(dot.style, {
                width: `${size}px`,
                height: `${size}px`,
                left: `${x}%`,
                bottom: `${y - 20}%`,
                background: color,
                boxShadow: `0 0 ${size * 2}px ${color}`,
                filter: `blur(${size * 0.3}px)`,
                animationDuration: `${dur}s`,
                animationDelay: `${delay}s`,
            });

            layer.appendChild(dot);
        }

        memoryContent.prepend(layer);
    })();

    // ========================================
    //  照片灯箱（Lightbox）
    // ========================================
    const lightbox = document.getElementById('photo-lightbox');
    const lightboxImg = document.getElementById('lightbox-img');
    const lightboxVideo = document.getElementById('lightbox-video');
    const lightboxClose = lightbox.querySelector('.lightbox-close');
    const lightboxOverlay = lightbox.querySelector('.lightbox-overlay');

    function openLightbox(src, type = 'image') {
        if (!src) return;

        lightbox.classList.add('is-loading');
        lightbox.classList.add('lightbox-show');
        document.body.style.overflow = 'hidden';

        if (type === 'video') {
            if (lightboxImg) lightboxImg.style.display = 'none';
            if (lightboxVideo) {
                lightboxVideo.style.display = 'block';
                lightboxVideo.src = src;
                lightboxVideo.load();
                lightboxVideo.onloadedmetadata = () => {
                    lightbox.classList.remove('is-loading');
                };
            }
        } else {
            if (lightboxVideo) {
                lightboxVideo.style.display = 'none';
                lightboxVideo.pause();
                lightboxVideo.src = '';
            }
            if (lightboxImg) {
                lightboxImg.style.display = 'block';
                const tempImg = new Image();
                tempImg.onload = () => {
                    lightboxImg.src = src;
                    lightbox.classList.remove('is-loading');
                };
                tempImg.src = src;
            }
        }
    }

    function closeLightbox() {
        lightbox.classList.remove('lightbox-show');
        lightbox.classList.remove('is-loading');
        document.body.style.overflow = '';
        
        if (lightboxVideo) {
            lightboxVideo.pause();
            lightboxVideo.src = '';
            lightboxVideo.load(); // 彻底卸载视频资源流
            lightboxVideo.style.display = 'none';
        }

        setTimeout(() => {
            if (lightboxImg) lightboxImg.src = '';
        }, 400);
    }

    lightboxClose.addEventListener('click', closeLightbox);
    lightboxOverlay.addEventListener('click', closeLightbox);

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && lightbox.classList.contains('lightbox-show')) {
            closeLightbox();
        }
    });

    // 全局暴露
    window.openLightbox = openLightbox;

    // ========================================
    //  换装魔镜 — AI 虚拟试衣
    // ========================================
    (function initTryOn() {
        const humanInput = document.getElementById('tryon-human-input');
        const garmInput  = document.getElementById('tryon-garm-input');
        const humanZone  = document.getElementById('tryon-human-zone');
        const garmZone   = document.getElementById('tryon-garm-zone');
        const humanInner = document.getElementById('tryon-human-inner');
        const garmInner  = document.getElementById('tryon-garm-inner');
        const humanPreview = document.getElementById('tryon-human-preview');
        const garmPreview  = document.getElementById('tryon-garm-preview');
        const submitBtn  = document.getElementById('tryon-submit');
        const statusDiv  = document.getElementById('tryon-status');
        const progressEl = document.getElementById('tryon-progress');
        const progressTxt= document.getElementById('tryon-progress-text');
        const resultEl   = document.getElementById('tryon-result');
        const resultImg  = document.getElementById('tryon-result-img');
        const downloadBtn= document.getElementById('tryon-download');
        const retryBtn   = document.getElementById('tryon-retry');
        const errorEl    = document.getElementById('tryon-error');
        const errorTxt   = document.getElementById('tryon-error-text');
        const errorRetry = document.getElementById('tryon-error-retry');

        let pollTimer = null;
        let currentHumanFile = null;
        let currentGarmFile  = null;

        // —— 上传区点击 ——
        humanZone.onclick = () => humanInput.click();
        garmZone.onclick  = () => garmInput.click();

        // —— 文件选择预览 ——
        function setupPreview(input, preview, inner) {
            input.onchange = (e) => {
                const file = e.target.files[0];
                if (!file) return;
                if (input === humanInput) currentHumanFile = file;
                else currentGarmFile = file;

                const reader = new FileReader();
                reader.onload = (ev) => {
                    preview.src = ev.target.result;
                    preview.style.display = 'block';
                    inner.style.opacity = '0';
                };
                reader.readAsDataURL(file);
            };
        }
        setupPreview(humanInput, humanPreview, humanInner);
        setupPreview(garmInput, garmPreview, garmInner);

        // —— 提交换衣 ——
        submitBtn.onclick = startTryOn;

        function startTryOn() {
            if (!currentHumanFile) { alert('请先上传人物照片'); return; }
            if (!currentGarmFile)  { alert('请先上传衣服图片'); return; }

            const category = document.querySelector('input[name="tryon-category"]:checked').value;
            const desc = document.getElementById('tryon-desc').value.trim();

            // 切换到加载状态
            submitBtn.disabled = true;
            statusDiv.style.display = 'flex';
            progressEl.style.display = 'flex';
            resultEl.style.display   = 'none';
            errorEl.style.display    = 'none';
            progressTxt.textContent  = 'AI 正在为你换装，请耐心等待约 30-60 秒…';

            const fd = new FormData();
            fd.append('image',    currentHumanFile);
            fd.append('garm_img', currentGarmFile);
            fd.append('category', category);
            fd.append('garment_des', desc);

            fetch(`${API_BASE}/try-on`, { method: 'POST', body: fd })
                .then(r => r.json())
                .then(data => {
                    if (data.task_id) {
                        pollTryOnStatus(data.task_id);
                    } else {
                        showTryOnError(data.error || '提交失败，请重试');
                    }
                })
                .catch(err => showTryOnError('网络错误：' + err.message));
        }

        // —— 轮询状态 ——
        function pollTryOnStatus(taskId) {
            let elapsed = 0;
            let currentInterval = 2000; // 初始 2 秒，比之前的 3 秒更激进
            let isPolling = true;

            const hints = [
                '分析人物与衣物特征中…',  // 0-8s
                'AI 模型全速渲染中…',    // 8-16s
                '即将完成，请稍候…',      // 16-24s
                '还在努力处理中，快了…',
            ];

            const doPoll = async () => {
                if (!isPolling) return;
                
                try {
                    const resp = await fetch(`${API_BASE}/try-on/${taskId}`);
                    const data = await resp.json();

                    if (data.status === 'succeeded') {
                        isPolling = false;
                        showTryOnResult(data.result_url);
                        return;
                    } else if (data.status === 'failed') {
                        isPolling = false;
                        showTryOnError(data.error || '生成失败，请重试');
                        return;
                    }
                } catch (e) {
                    // 网络抖动，静默失败，继续等待
                }

                elapsed += (currentInterval / 1000);
                
                // 更换提示语 (每 8 秒换一句)
                const idx = Math.min(Math.floor(elapsed / 8), hints.length - 1);
                progressTxt.textContent = hints[idx];

                if (elapsed > 180) {
                    isPolling = false;
                    showTryOnError('等待超时（3分钟），请再试一次');
                    return;
                }

                // 退避策略：如果等待超过20秒，将前端轮询放缓至4秒一次，由于后端也是按退避策略询问Replicate
                if (elapsed > 20) currentInterval = 4000;

                pollTimer = setTimeout(doPoll, currentInterval);
            };

            // 启动首次轮询
            if (pollTimer) clearTimeout(pollTimer);
            pollTimer = setTimeout(doPoll, currentInterval);
        }

        // —— 显示结果 ——
        function showTryOnResult(url) {
            progressEl.style.display = 'none';
            resultEl.style.display   = 'flex';
            resultImg.src = url;
            submitBtn.disabled = false;

            // 下载（兼容手机和电脑）
            downloadBtn.onclick = async () => {
                const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
                try {
                    downloadBtn.textContent = '⏳ 正在保存…';
                    downloadBtn.disabled = true;
                    const resp = await fetch(url);
                    if (!resp.ok) throw new Error('fetch failed');
                    const blob = await resp.blob();
                    const objectUrl = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = objectUrl;
                    a.download = 'try-on-result.jpg';
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    setTimeout(() => URL.revokeObjectURL(objectUrl), 3000);
                    downloadBtn.textContent = '✅ 已保存！';
                    setTimeout(() => {
                        downloadBtn.textContent = '💾 保存图片';
                        downloadBtn.disabled = false;
                    }, 2000);
                } catch (e) {
                    // blob下载失败时兜底：移动端提示长按，PC端打开新标签
                    downloadBtn.textContent = '💾 保存图片';
                    downloadBtn.disabled = false;
                    if (isMobile) {
                        alert('请长按图片 → 选择"保存图片"或"添加到相册"即可保存 📱');
                    } else {
                        window.open(url, '_blank');
                    }
                }
            };

            // 重试
            retryBtn.onclick = resetTryOn;
        }

        // —— 显示错误 ——
        function showTryOnError(msg) {
            progressEl.style.display = 'none';
            errorEl.style.display    = 'flex';
            errorTxt.textContent     = msg;
            submitBtn.disabled = false;
            errorRetry.onclick = resetTryOn;
        }

        // —— 重置界面 ——
        function resetTryOn() {
            if (pollTimer) clearTimeout(pollTimer);
            statusDiv.style.display  = 'none';
            progressEl.style.display = 'flex';
            resultEl.style.display   = 'none';
            errorEl.style.display    = 'none';
            submitBtn.disabled = false;
        }

        // 打开弹窗时重置换衣表单
        const origOpen = openModal;
        // NOTE: openModal 已在外层定义，换衣弹窗打开时不需要额外初始化
    })();
});
