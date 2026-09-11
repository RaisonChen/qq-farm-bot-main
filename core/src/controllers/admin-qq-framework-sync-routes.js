const fetch = require('node-fetch');

const QQ_FRAMEWORK_REQUEST_TIMEOUT_MS = 15_000;
const QQ_FRAMEWORK_AUTO_RECONNECT_POLL_MS = 60_000;
// 掉线重连冷却：同一账号在该时间窗内只自动重连一次，避免接口抖动导致反复拉取
const QQ_FRAMEWORK_RECONNECT_COOLDOWN_MS = 5 * 60 * 1000;
const LOGIN_TYPE_QQ_FRAMEWORK = 'qq_framework_sync';

const reconnectLastAttemptAt = new Map(); // accountId => timestamp

function normalizeServerUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (raw.length > 500) throw new Error('QQ 框架服务地址无效（长度超限）');
    let url;
    try {
        url = new URL(raw);
    } catch {
        throw new Error('QQ 框架服务地址格式无效');
    }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
        throw new Error('QQ 框架服务地址仅支持不含账号密码的 http(s) 地址');
    }
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString().replace(/\/+$/, '');
}

function buildFrameworkUrl(serverUrl, path, query = {}) {
    const base = normalizeServerUrl(serverUrl);
    if (!base) throw new Error('QQ 框架服务地址未配置');
    const qs = Object.entries(query)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v ?? ''))}`)
        .join('&');
    return qs ? `${base}${path}?${qs}` : `${base}${path}`;
}

async function frameworkGet(serverUrl, path, query = {}, options = {}) {
    const fullUrl = buildFrameworkUrl(serverUrl, path, query);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeout || QQ_FRAMEWORK_REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(fullUrl, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal: controller.signal,
        });
        const text = await response.text();
        let data = null;
        try {
            data = text ? JSON.parse(text) : null;
        } catch {
            throw new Error(`QQ 框架服务返回了无效响应（HTTP ${response.status}）`);
        }
        if (!response.ok) {
            const msg = (data && (data.error || data.message)) || `QQ 框架请求失败（HTTP ${response.status}）`;
            throw new Error(msg);
        }
        return data;
    } finally {
        clearTimeout(timeout);
    }
}

function logFrameworkEvent(logger, level, message, extras = {}) {
    try {
        if (!logger) return;
        const fn = typeof logger[level] === 'function' ? logger[level] : logger.info;
        if (typeof fn === 'function') fn(`[QQ框架同步] ${message}`, extras);
    } catch {}
}

function logAccountEvent(provider, type, message, accountId, accountName, extras) {
    try {
        if (provider && typeof provider.addAccountLog === 'function') {
            provider.addAccountLog(type, message, accountId, accountName || '', extras || {});
        }
    } catch {}
}

/**
 * 获取账号运行状态中是否处于离线/错误状态
 * 返回: { running: boolean, offline: boolean }
 * offline=true 代表运行中但出现 wsError/断连
 */
function getAccountRunState(provider, accountId) {
    try {
        const running = provider && typeof provider.isAccountRunning === 'function'
            ? provider.isAccountRunning(accountId)
            : false;
        if (!running) return { running: false, offline: false };
        const status = typeof provider.getStatus === 'function' ? provider.getStatus(accountId) : null;
        const hasWsError = !!(status && status.wsError);
        return { running: true, offline: hasWsError };
    } catch {
        return { running: false, offline: false };
    }
}

/**
 * 通过 QQ 号查找已有账号（按 qq / uin 两个字段匹配，字符串化比较）
 */
function findAccountByQq(accounts, qqNumber) {
    if (!Array.isArray(accounts) || !qqNumber && qqNumber !== 0) return null;
    const target = String(qqNumber).trim();
    if (!target) return null;
    return accounts.find((acc) => {
        const qq = String(acc?.qq ?? '').trim();
        const uin = String(acc?.uin ?? '').trim();
        return qq === target || uin === target;
    }) || null;
}

/**
 * 同步单个账号：存在则更新，不存在则添加；完成后根据 wasRunning 自动启动/重启
 * @param {object} args
 * @param {object} args.store
 * @param {object} args.provider
 * @param {object} args.logger
 * @param {object} args.item       — /all 返回的单条 { qq, nickname, code, ok }
 * @param {string} [args.ownerUsername] — 新建账号或原账号无 owner 时，作为账号归属写入的 username；用于触发用户默认方案
 * @returns {Promise<{account: object, updated: boolean, created: boolean, started: boolean, planApplied: boolean}>}
 */
async function syncOneAccount({ store, provider, logger, item, ownerUsername }) {
    if (!item || typeof item !== 'object') throw new Error('同步数据为空');
    const qqRaw = item.qq;
    const code = String(item.code || '').trim();
    const nickname = String(item.nickname || '').trim();
    const qqStr = String(qqRaw ?? '').trim();
    const owner = String(ownerUsername || '').trim();
    if (!qqStr) throw new Error('缺少 QQ 号');
    if (!code) throw new Error(`QQ=${qqStr} 缺少有效的 code`);

    const accounts = store.getAccounts().accounts;
    const existing = findAccountByQq(accounts, qqRaw);

    let account;
    let updated = false;
    let created = false;
    let wasRunning = false;
    let planApplied = false;

    if (existing) {
        wasRunning = provider && typeof provider.isAccountRunning === 'function'
            ? provider.isAccountRunning(existing.id)
            : false;
        const existingUsername = String(existing.username || '').trim();
        const payload = {
            id: existing.id,
            code,
            platform: 'qq',
            qq: qqStr,
            uin: qqStr,
            loginType: LOGIN_TYPE_QQ_FRAMEWORK,
        };
        if (nickname && !existing.name) payload.name = nickname;
        // 原账号没有归属人的，补上当前同步操作人作为 username（便于后续默认方案/权限管理）
        if (!existingUsername && owner) payload.username = owner;
        const result = store.addOrUpdateAccount(payload);
        account = result.accounts.find((a) => String(a.id) === String(existing.id)) || existing;
        updated = true;
        logFrameworkEvent(logger, 'info', `更新账号 QQ=${qqStr} name=${account?.name || existing.name || ''}`,
            { accountId: existing.id, updated: true });
    } else {
        const payload = {
            name: nickname || `QQ${qqStr}`,
            code,
            platform: 'qq',
            qq: qqStr,
            uin: qqStr,
            loginType: LOGIN_TYPE_QQ_FRAMEWORK,
            ...(owner ? { username: owner } : {}),
        };
        const result = store.addOrUpdateAccount(payload);
        account = result.accounts[result.accounts.length - 1] || null;
        if (!account) throw new Error(`QQ=${qqStr} 添加账号失败`);
        created = true;
        wasRunning = false;
        // addOrUpdateAccount 内部在 created+username 时会自动应用 userDefaultAccountPlans[username]
        if (owner) {
            const plan = store.getUserDefaultAccountPlan && typeof store.getUserDefaultAccountPlan === 'function'
                ? store.getUserDefaultAccountPlan(owner)
                : null;
            planApplied = !!(plan && plan.exists && plan.enabled !== false);
        }
        logFrameworkEvent(logger, 'info', `新增账号 QQ=${qqStr} name=${account.name || ''}`,
            { accountId: account.id, created: true, ownerUsername: owner || '', planApplied });
    }

    let started = false;
    const accountId = account.id;
    const accountName = account?.name || '';
    try {
        if (created) {
            if (provider && typeof provider.startAccount === 'function') {
                await provider.startAccount(accountId);
                started = true;
                logAccountEvent(provider, 'run', `QQ 框架同步：新增账号已启动 ${accountName || accountId}`,
                    accountId, accountName, { loginType: LOGIN_TYPE_QQ_FRAMEWORK, qq: qqStr });
            }
        } else if (updated) {
            if (wasRunning) {
                if (provider && typeof provider.restartAccount === 'function') {
                    await provider.restartAccount(accountId);
                    started = true;
                    logAccountEvent(provider, 'restart', `QQ 框架同步：更新 code 后重启 ${accountName || accountId}`,
                        accountId, accountName, { loginType: LOGIN_TYPE_QQ_FRAMEWORK, qq: qqStr });
                }
            } else if (provider && typeof provider.startAccount === 'function') {
                // 更新但未在运行，按“同步后自动运行”要求启动
                await provider.startAccount(accountId);
                started = true;
                logAccountEvent(provider, 'run', `QQ 框架同步：更新 code 后启动 ${accountName || accountId}`,
                    accountId, accountName, { loginType: LOGIN_TYPE_QQ_FRAMEWORK, qq: qqStr });
            }
        }
    } catch (error) {
        logFrameworkEvent(logger, 'warn', `自动启动账号失败 QQ=${qqStr}`,
            { accountId, error: error.message, created, updated });
    }

    return { account, updated, created, started, planApplied };
}

/**
 * 执行一键同步：调用 /all 获取列表，过滤 ok=true 的项后逐个同步
 * @param {object} args
 * @param {object} args.store
 * @param {object} args.provider
 * @param {object} args.logger
 * @param {string} [args.ownerUsername] — 同步发起人的 username，新建账号时写入作为 owner，用于默认方案匹配
 */
async function runSyncAll({ store, provider, logger, ownerUsername }) {
    const config = store.getQqFrameworkSyncConfig();
    const serverUrl = normalizeServerUrl(config.serverUrl);
    const apiToken = String(config.apiToken || '').trim();
    if (!serverUrl) throw new Error('QQ 框架服务地址未配置');
    if (!apiToken) throw new Error('QQ 框架 API Token 未配置');

    const resp = await frameworkGet(serverUrl, '/all', { token: apiToken });
    if (!resp || resp.code !== 0) {
        const msg = (resp && resp.error) || resp?.message || `QQ 框架 /all 接口返回失败（code=${resp?.code}）`;
        throw new Error(msg);
    }
    const list = Array.isArray(resp.data) ? resp.data : [];
    const validItems = list.filter((item) => item && item.ok === true);
    const owner = String(ownerUsername || '').trim();

    logFrameworkEvent(logger, 'info', `一键同步：获取 ${list.length} 条记录，有效 ${validItems.length} 条${owner ? `，owner=${owner}` : ''}`);

    const results = [];
    const errors = [];
    for (const item of validItems) {
        try {
            const result = await syncOneAccount({ store, provider, logger, item, ownerUsername: owner });
            results.push({ qq: item.qq, created: result.created, updated: result.updated, started: result.started, planApplied: result.planApplied, accountId: result.account?.id });
        } catch (error) {
            errors.push({ qq: item?.qq, error: error.message });
            logFrameworkEvent(logger, 'warn', `同步失败 QQ=${item?.qq}`, { error: error.message });
        }
    }

    return {
        total: list.length,
        valid: validItems.length,
        added: results.filter((r) => r.created).length,
        updated: results.filter((r) => r.updated).length,
        started: results.filter((r) => r.started).length,
        planApplied: results.filter((r) => r.planApplied).length,
        ownerUsername: owner || '',
        errors,
        results,
    };
}

/**
 * 单个账号掉线重连：调用 /code 获取新 code，更新并重启
 */
async function runReconnectAccount({ store, provider, logger, account }) {
    if (!account) throw new Error('账号不存在');
    const accountId = String(account.id);
    const qq = account.qq || account.uin;
    if (!qq) throw new Error('账号缺少 QQ/uin 信息，无法拉取 code');

    const config = store.getQqFrameworkSyncConfig();
    const serverUrl = normalizeServerUrl(config.serverUrl);
    const apiToken = String(config.apiToken || '').trim();
    if (!serverUrl || !apiToken) return { skipped: true, reason: '未配置 QQ 框架服务地址或 API Token' };

    const now = Date.now();
    const lastAt = Number(reconnectLastAttemptAt.get(accountId) || 0);
    if (lastAt && now - lastAt < QQ_FRAMEWORK_RECONNECT_COOLDOWN_MS) {
        return { skipped: true, reason: '处于重连冷却时间内' };
    }
    reconnectLastAttemptAt.set(accountId, now);

    const resp = await frameworkGet(serverUrl, '/code', { qq, token: apiToken });
    if (!resp || resp.code !== 0) {
        throw new Error((resp && (resp.error || resp.message)) || `QQ 框架 /code 接口失败（code=${resp?.code}）`);
    }
    const code = String(resp?.data?.code || '').trim();
    if (!code) throw new Error('/code 接口没有返回有效的 code');

    const wasRunning = provider && typeof provider.isAccountRunning === 'function'
        ? provider.isAccountRunning(accountId)
        : false;

    const newPayload = { id: accountId, code, platform: 'qq', loginType: LOGIN_TYPE_QQ_FRAMEWORK };
    store.addOrUpdateAccount(newPayload);

    let restarted = false;
    let started = false;
    try {
        if (wasRunning) {
            if (provider && typeof provider.restartAccount === 'function') {
                await provider.restartAccount(accountId);
                restarted = true;
            }
        } else if (provider && typeof provider.startAccount === 'function') {
            await provider.startAccount(accountId);
            started = true;
        }
    } catch (error) {
        logFrameworkEvent(logger, 'warn', `掉线重连后启动失败 accountId=${accountId}`, { error: error.message });
        throw error;
    }

    const accountName = account?.name || '';
    logAccountEvent(provider, restarted ? 'restart' : (started ? 'run' : 'update'),
        `QQ 框架掉线重连：刷新 code 并${restarted ? '重启' : (started ? '启动' : '更新')} ${accountName || accountId}`,
        accountId, accountName, { loginType: LOGIN_TYPE_QQ_FRAMEWORK, qq });
    return { restarted, started, updated: true };
}

/**
 * 后台掉线重连轮询：每 60s 扫描一次，针对 loginType 为 qq_framework_sync 的离线账号
 */
function createAutoReconnectWatcher({ store, provider, logger }) {
    let stopped = false;
    let timer = null;

    async function tick() {
        if (stopped) return;
        try {
            const config = store.getQqFrameworkSyncConfig();
            if (config.autoReconnect !== true) return;
            const serverUrl = normalizeServerUrl(config.serverUrl);
            const apiToken = String(config.apiToken || '').trim();
            if (!serverUrl || !apiToken) return;

            const accounts = (store.getAccounts().accounts || []).filter(
                (acc) => acc && String(acc.loginType || '') === LOGIN_TYPE_QQ_FRAMEWORK
            );
            if (!accounts.length) return;

            for (const account of accounts) {
                if (stopped) break;
                const id = String(account.id);
                const state = getAccountRunState(provider, id);
                // 命中场景：运行中但已离线（wsError 出现），或 loginType 标记了框架同步但 Worker 不存在（意外退出）
                const needReconnect = state.offline || (!state.running && account.autoStart !== false);
                if (!needReconnect) continue;
                try {
                    const res = await runReconnectAccount({ store, provider, logger, account });
                    if (res && (res.restarted || res.started)) {
                        logFrameworkEvent(logger, 'info', `掉线重连完成 accountId=${id} qq=${account.qq || account.uin}`,
                            { restarted: !!res.restarted, started: !!res.started });
                    }
                } catch (error) {
                    logFrameworkEvent(logger, 'warn', `掉线重连失败 accountId=${id} qq=${account.qq || account.uin}`,
                        { error: error.message });
                }
            }
        } catch (error) {
            logFrameworkEvent(logger, 'warn', `掉线重连轮询异常`, { error: error.message });
        }
    }

    timer = setInterval(() => { void tick(); }, QQ_FRAMEWORK_AUTO_RECONNECT_POLL_MS);
    if (typeof timer.unref === 'function') timer.unref();

    // 启动时也立即触发一次快速巡检（延迟几秒错开启动风暴）
    setTimeout(() => { void tick(); }, 8_000);

    function stop() {
        stopped = true;
        if (timer) {
            try { clearInterval(timer); } catch {}
            timer = null;
        }
    }

    return { stop };
}

function registerAdminQqFrameworkSyncRoutes({
    app,
    store,
    provider,
    logger,
    requireAdminRole,
    requireDangerConfirmation,
}) {
    const watcher = createAutoReconnectWatcher({ store, provider, logger });

    app.get('/api/admin/qq-framework-sync-config', requireAdminRole, (req, res) => {
        try {
            const config = store.getQqFrameworkSyncConfig();
            res.json({
                ok: true,
                data: {
                    serverUrl: normalizeServerUrl(config.serverUrl),
                    apiToken: '',
                    tokenConfigured: !!String(config.apiToken || '').trim(),
                    autoReconnect: config.autoReconnect === true,
                },
            });
        } catch (error) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/admin/qq-framework-sync-config', requireAdminRole, (req, res) => {
        try {
            if (!requireDangerConfirmation(req, res, 'UPDATE_QQ_FRAMEWORK_SYNC_CONFIG')) return;
            const input = req.body || {};
            const current = store.getQqFrameworkSyncConfig();
            const serverUrl = input.serverUrl !== undefined && input.serverUrl !== null
                ? normalizeServerUrl(input.serverUrl)
                : normalizeServerUrl(current.serverUrl);
            const apiToken = (input.apiToken === undefined || input.apiToken === null || input.apiToken === '')
                ? String(current.apiToken || '').trim()
                : String(input.apiToken).trim();
            const autoReconnect = input.autoReconnect === true;

            if (autoReconnect && (!serverUrl || !apiToken)) {
                return res.status(400).json({ ok: false, error: '开启掉线重连前请先填写服务地址与 API Token' });
            }

            const data = store.setQqFrameworkSyncConfig({ serverUrl, apiToken, autoReconnect });
            try {
                if (logger && typeof logger.warn === 'function') {
                    logger.warn('更新 QQ 框架自动同步配置', {
                        admin: req.currentUser?.username || '',
                        serverUrl: data.serverUrl,
                        autoReconnect: data.autoReconnect === true,
                        tokenConfigured: !!String(data.apiToken || '').trim(),
                        confirmation: 'UPDATE_QQ_FRAMEWORK_SYNC_CONFIG',
                    });
                }
            } catch {}
            res.json({
                ok: true,
                data: {
                    serverUrl: normalizeServerUrl(data.serverUrl),
                    apiToken: '',
                    tokenConfigured: !!String(data.apiToken || '').trim(),
                    autoReconnect: data.autoReconnect === true,
                },
            });
        } catch (error) {
            res.status(400).json({ ok: false, error: error.message });
        }
    });

    // 一键同步
    app.post('/api/admin/qq-framework-sync/sync-all', requireAdminRole, async (req, res) => {
        try {
            const ownerUsername = String(req.currentUser?.username || '').trim();
            const summary = await runSyncAll({ store, provider, logger, ownerUsername });
            try {
                if (logger && typeof logger.info === 'function') {
                    logger.info('QQ 框架一键同步完成', {
                        admin: ownerUsername,
                        total: summary.total,
                        valid: summary.valid,
                        added: summary.added,
                        updated: summary.updated,
                        started: summary.started,
                        planApplied: summary.planApplied,
                        errors: summary.errors.length,
                    });
                }
            } catch {}
            res.json({ ok: true, data: summary });
        } catch (error) {
            res.status(400).json({ ok: false, error: error.message });
        }
    });

    return { watcher };
}

module.exports = {
    LOGIN_TYPE_QQ_FRAMEWORK,
    normalizeServerUrl,
    buildFrameworkUrl,
    frameworkGet,
    findAccountByQq,
    syncOneAccount,
    runSyncAll,
    runReconnectAccount,
    createAutoReconnectWatcher,
    registerAdminQqFrameworkSyncRoutes,
};
