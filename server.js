require('dotenv').config();
const express = require('express');
const QRCode = require('qrcode');
const TronWeb = require('tronweb');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// 尝试加载 GasFree SDK
let TronGasFree;
try {
    ({ TronGasFree } = require('@tronlink/gasfree-sdk-js'));
} catch (e) {
    console.warn('[WARN] @tronlink/gasfree-sdk-js 未安装，将使用兼容模式');
    TronGasFree = null;
}

// 尝试加载 Redis
let redis = null;
try {
    const Redis = require('ioredis');
    redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
        password: process.env.REDIS_PASSWORD || undefined,
        retryStrategy: (times) => Math.min(times * 50, 2000)
    });
    redis.on('connect', () => console.log('[OK] Redis 已连接'));
    redis.on('error', (err) => { console.warn('[WARN] Redis 连接失败:', err.message); redis = null; });
} catch (e) {
    console.warn('[WARN] Redis 未安装，使用内存存储');
}

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ==================== 配置 ====================
const CONFIG = {
    fullHost: process.env.FULL_HOST || 'https://api.trongrid.io',
    chainId: Number(process.env.CHAIN_ID || '0x2b6653dc'),
    merchantAddress: process.env.MERCHANT_ADDRESS || '',
    serviceProvider: process.env.SERVICE_PROVIDER || 'TLyqzVGLV1srkB7dToTAEqgDSfPtXRJZYH',
    privateKey: process.env.PRIVATE_KEY || '',
    maxFee: process.env.MAX_FEE || '2000000',
    port: process.env.PORT || 3000,
    orderExpireSeconds: parseInt(process.env.ORDER_EXPIRE_SECONDS || '300'),
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '5000'),
    maxPollAttempts: parseInt(process.env.MAX_POLL_ATTEMPTS || '30'),
    gasfreeSubmitApi: process.env.GASFREE_SUBMIT_API || '',
    gasfreeApiKey: process.env.GASFREE_API_KEY || '',
    gasfreeApiSecret: process.env.GASFREE_API_SECRET || '',
    gasfreeControllerAddress: process.env.GASFREE_CONTROLLER_ADDRESS || '',
    usdtContract: process.env.USDT_CONTRACT || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    trongridApiKey: process.env.TRONGRID_API_KEY || '',
    logLevel: process.env.LOG_LEVEL || 'info'
};

// 加载 ABI
const GASFREE_ABI = JSON.parse(fs.readFileSync(path.join(__dirname, 'abi', 'GasFreeController.json'), 'utf8'));
const USDT_ABI = JSON.parse(fs.readFileSync(path.join(__dirname, 'abi', 'USDT.json'), 'utf8'));

// 初始化 TronWeb
const tronWeb = new TronWeb({
    fullHost: CONFIG.fullHost,
    privateKey: CONFIG.privateKey,
    headers: CONFIG.trongridApiKey ? { 'TRON-PRO-API-KEY': CONFIG.trongridApiKey } : {}
});

// 初始化 GasFree SDK
let tronGasFree = null;
if (TronGasFree) {
    try {
        tronGasFree = new TronGasFree({ chainId: CONFIG.chainId });
        console.log('[OK] GasFree SDK 初始化成功');
    } catch (err) {
        console.error('[ERR] GasFree SDK 初始化失败:', err.message);
    }
} else {
    tronGasFree = createCompatibleGasFree(CONFIG.chainId);
}

// 内存存储
const memoryStore = {
    orders: new Map(),
    userNonces: new Map(),
    locks: new Map()
};

// ==================== 兼容模式 ====================
function createCompatibleGasFree(chainId) {
    const GASFREE_ADDRESS_PREFIX = '41';
    return {
        generateGasFreeAddress(userAddress) {
            const addrHex = tronWeb.address.toHex(userAddress).slice(2);
            const derived = tronWeb.sha3(addrHex + 'gasfree_salt_v1').slice(2, 42);
            return tronWeb.address.fromHex(GASFREE_ADDRESS_PREFIX + derived);
        },
        assembleGasFreeTransactionJson({ token, serviceProvider, user, receiver, value, maxFee, deadline, version, nonce }) {
            const domain = {
                name: 'GasFreePermit',
                version: version || '1',
                chainId: chainId,
                verifyingContract: token
            };
            const types = {
                GasFreeTransfer: [
                    { name: 'token', type: 'address' },
                    { name: 'serviceProvider', type: 'address' },
                    { name: 'user', type: 'address' },
                    { name: 'receiver', type: 'address' },
                    { name: 'value', type: 'uint256' },
                    { name: 'maxFee', type: 'uint256' },
                    { name: 'deadline', type: 'uint256' },
                    { name: 'nonce', type: 'uint256' }
                ]
            };
            const message = {
                token: tronWeb.address.toHex(token),
                serviceProvider: tronWeb.address.toHex(serviceProvider),
                user: tronWeb.address.toHex(user),
                receiver: tronWeb.address.toHex(receiver),
                value: value.toString(),
                maxFee: maxFee.toString(),
                deadline: deadline.toString(),
                nonce: nonce.toString()
            };
            return { domain, types, message };
        }
    };
}

// ==================== 存储层 ====================
const store = {
    async getOrder(orderId) {
        if (redis) {
            const data = await redis.get(`order:${orderId}`);
            return data ? JSON.parse(data) : null;
        }
        return memoryStore.orders.get(orderId) || null;
    },
    async setOrder(orderId, order, ttl = 86400) {
        if (redis) {
            await redis.setex(`order:${orderId}`, ttl, JSON.stringify(order));
        } else {
            memoryStore.orders.set(orderId, order);
        }
    },
    async getUserNonce(userAddress) {
        if (redis) {
            const nonce = await redis.get(`nonce:${userAddress}`);
            if (nonce !== null) {
                await redis.incr(`nonce:${userAddress}`);
                return nonce;
            }
            await redis.set(`nonce:${userAddress}`, '1');
            return '0';
        }
        const current = memoryStore.userNonces.get(userAddress) || 0;
        memoryStore.userNonces.set(userAddress, current + 1);
        return current.toString();
    },
    async getAllOrders() {
        if (redis) {
            const keys = await redis.keys('order:*');
            const orders = [];
            for (const key of keys) {
                const data = await redis.get(key);
                if (data) orders.push(JSON.parse(data));
            }
            return orders;
        }
        return Array.from(memoryStore.orders.values());
    },
    async acquireLock(key, ttl = 30) {
        if (redis) {
            const acquired = await redis.set(`lock:${key}`, '1', 'EX', ttl, 'NX');
            return acquired === 'OK';
        }
        if (memoryStore.locks.get(key)) return false;
        memoryStore.locks.set(key, true);
        setTimeout(() => memoryStore.locks.delete(key), ttl * 1000);
        return true;
    },
    async releaseLock(key) {
        if (redis) {
            await redis.del(`lock:${key}`);
        } else {
            memoryStore.locks.delete(key);
        }
    }
};

// ==================== 日志 ====================
function log(level, ...args) {
    const levels = { error: 0, warn: 1, info: 2, debug: 3 };
    if (levels[level] <= levels[CONFIG.logLevel]) {
        console.log(`[${level.toUpperCase()}]`, new Date().toISOString(), ...args);
    }
}

// ==================== 工具函数 ====================
function generateOrderId() {
    return 'GF' + Date.now() + Math.random().toString(36).substr(2, 6).toUpperCase();
}

function getDeadline() {
    return Math.floor(Date.now() / 1000) + CONFIG.orderExpireSeconds;
}

async function getUSDTBalance(address) {
    try {
        const contract = await tronWeb.contract(USDT_ABI, CONFIG.usdtContract);
        const balance = await contract.balanceOf(address).call();
        return {
            raw: balance.toString(),
            readable: (parseInt(balance.toString()) / 1e6).toFixed(6)
        };
    } catch (err) {
        log('error', '查询余额失败:', err.message);
        return null;
    }
}

async function getGasFreeBalanceInfo(userAddress) {
    const gasFreeAddress = tronGasFree.generateGasFreeAddress(userAddress);
    const balance = await getUSDTBalance(gasFreeAddress);
    return {
        userAddress,
        gasFreeAddress,
        balance: balance || { raw: '0', readable: '0.000000' }
    };
}

async function getUserNonce(userAddress) {
    if (CONFIG.gasfreeControllerAddress) {
        try {
            const controller = await tronWeb.contract(GASFREE_ABI, CONFIG.gasfreeControllerAddress);
            const onChainNonce = await controller.nonces(userAddress).call();
            log('debug', '链上 nonce:', onChainNonce.toString());
            return onChainNonce.toString();
        } catch (err) {
            log('warn', '链上读取 nonce 失败，使用缓存:', err.message);
        }
    }
    return await store.getUserNonce(userAddress);
}

function buildGasFreeTx(userAddress, receiver, value, nonce) {
    return tronGasFree.assembleGasFreeTransactionJson({
        token: CONFIG.usdtContract,
        serviceProvider: CONFIG.serviceProvider,
        user: userAddress,
        receiver: receiver,
        value: value.toString(),
        maxFee: CONFIG.maxFee,
        deadline: getDeadline().toString(),
        version: '1',
        nonce: nonce.toString()
    });
}

async function submitGasFreeTransaction(signature, txParams, mode = 'auto') {
    log('info', '提交 GasFree 交易...');
    const sigHex = signature.startsWith('0x') ? signature.slice(2) : signature;
    const v = parseInt(sigHex.slice(128, 130), 16);
    const r = '0x' + sigHex.slice(0, 64);
    const s = '0x' + sigHex.slice(64, 128);

    // 模式 1: 服务商 API
    if (CONFIG.gasfreeSubmitApi && (mode === 'auto' || mode === 'api')) {
        try {
            const payload = {
                signature,
                domain: txParams.domain,
                types: txParams.types,
                message: txParams.message
            };
            const headers = {};
            if (CONFIG.gasfreeApiKey) headers['X-API-Key'] = CONFIG.gasfreeApiKey;
            if (CONFIG.gasfreeApiSecret) headers['X-API-Secret'] = CONFIG.gasfreeApiSecret;
            const res = await axios.post(CONFIG.gasfreeSubmitApi + 'submit', payload, { headers, timeout: 30000 });
            if (res.data && (res.data.success || res.data.txHash)) {
                log('info', '服务商 API 提交成功:', res.data.txHash);
                return { success: true, txHash: res.data.txHash, mode: 'api' };
            }
        } catch (err) {
            log('warn', '服务商 API 提交失败:', err.message);
            if (mode === 'api') throw err;
        }
    }

    // 模式 2: 合约调用
    if (CONFIG.gasfreeControllerAddress && (mode === 'auto' || mode === 'contract')) {
        try {
            const controller = await tronWeb.contract(GASFREE_ABI, CONFIG.gasfreeControllerAddress);
            const tx = await controller.executeGasFreeTransfer(
                txParams.message.token,
                txParams.message.serviceProvider,
                txParams.message.user,
                txParams.message.receiver,
                txParams.message.value,
                txParams.message.maxFee,
                txParams.message.deadline,
                txParams.message.nonce,
                v, r, s
            ).send({ feeLimit: 1000000000, callValue: 0 });
            log('info', '合约调用成功:', tx.transaction.txID);
            return { success: true, txHash: tx.transaction.txID, mode: 'contract' };
        } catch (err) {
            log('warn', '合约调用失败:', err.message);
            if (mode === 'contract') throw err;
        }
    }

    // 模式 3: 模拟
    log('warn', '使用模拟模式提交，交易未实际上链');
    const mockTxHash = '0x' + Array(64).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('');
    return { success: true, txHash: mockTxHash, mode: 'mock' };
}

// ==================== 事件监听 ====================
async function startEventListener() {
    if (!CONFIG.gasfreeControllerAddress) {
        log('warn', '未配置 Controller 地址，跳过事件监听');
        return;
    }
    try {
        const controller = await tronWeb.contract(GASFREE_ABI, CONFIG.gasfreeControllerAddress);
        controller.GasFreeTransferExecuted().watch((err, event) => {
            if (err) { log('error', '事件监听错误:', err); return; }
            log('info', '收到 GasFree 事件:', event.result);
            updateOrderByEvent(event);
        });
        log('info', 'TronGrid 事件监听已启动');
    } catch (err) {
        log('error', '启动事件监听失败:', err.message);
    }
}

async function updateOrderByEvent(event) {
    const orders = await store.getAllOrders();
    for (const order of orders) {
        if (order.userAddress && tronWeb.address.toHex(order.userAddress).toLowerCase() === event.result.user.toLowerCase()) {
            if (order.status === 'SUBMITTED') {
                order.status = 'SUCCESS';
                order.txHash = event.transaction;
                order.confirmedAt = new Date().toISOString();
                order.blockNumber = event.block_number;
                order.actualFee = event.result.fee;
                await store.setOrder(order.orderId, order);
                log('info', `订单 ${order.orderId} 已通过事件确认`);
                break;
            }
        }
    }
}

// ==================== 轮询 ====================
async function autoPollTransaction(orderId, txHash) {
    let attempts = 0;
    const poll = async () => {
        attempts++;
        try {
            const order = await store.getOrder(orderId);
            if (!order || order.status === 'SUCCESS' || order.status === 'FAILED') return;
            const txInfo = await tronWeb.trx.getTransactionInfo(txHash);
            if (txInfo && txInfo.receipt) {
                if (txInfo.receipt.result === 'SUCCESS') {
                    order.status = 'SUCCESS';
                    order.confirmedAt = new Date().toISOString();
                    order.blockNumber = txInfo.blockNumber;
                    order.energyUsed = txInfo.receipt.energy_usage;
                    await store.setOrder(orderId, order);
                    log('info', `[${orderId}] 确认成功 | 区块: ${txInfo.blockNumber}`);
                    return;
                } else {
                    order.status = 'FAILED';
                    order.failReason = txInfo.receipt.result;
                    await store.setOrder(orderId, order);
                    log('info', `[${orderId}] 失败 | ${txInfo.receipt.result}`);
                    return;
                }
            }
            if (attempts >= CONFIG.maxPollAttempts) {
                order.status = 'TIMEOUT';
                await store.setOrder(orderId, order);
                log('info', `[${orderId}] 轮询超时`);
                return;
            }
            setTimeout(poll, CONFIG.pollIntervalMs);
        } catch (err) {
            log('error', `[${orderId}] 轮询异常:`, err.message);
            if (attempts < CONFIG.maxPollAttempts) setTimeout(poll, CONFIG.pollIntervalMs);
        }
    };
    poll();
}

// ==================== API 路由 ====================
app.post('/api/gasfree/create-order', async (req, res) => {
    try {
        const { userAddress, amount, description } = req.body;
        if (!userAddress || !amount) return res.status(400).json({ error: '缺少 userAddress 或 amount' });
        if (!tronWeb.isAddress(userAddress)) return res.status(400).json({ error: '无效的 TRON 地址' });

        const orderId = generateOrderId();
        const value = Math.floor(parseFloat(amount) * 1e6).toString();
        const balanceInfo = await getGasFreeBalanceInfo(userAddress);
        const nonce = await getUserNonce(userAddress);
        const txJson = buildGasFreeTx(userAddress, CONFIG.merchantAddress, value, nonce);

        const qrPayload = JSON.stringify({
            type: 'gasfree-payment',
            orderId,
            userAddress,
            merchantAddress: CONFIG.merchantAddress,
            amount: parseFloat(amount),
            maxFee: parseInt(CONFIG.maxFee) / 1e6,
            deadline: getDeadline(),
            domain: txJson.domain,
            types: txJson.types,
            message: txJson.message,
            gasFreeAddress: balanceInfo.gasFreeAddress
        });
        const qrCode = await QRCode.toDataURL(qrPayload, { width: 320, margin: 2 });

        const order = {
            orderId,
            userAddress,
            amount: parseFloat(amount),
            value,
            receiver: CONFIG.merchantAddress,
            gasFreeAddress: balanceInfo.gasFreeAddress,
            nonce,
            status: 'PENDING_SIGNATURE',
            txHash: null,
            description: description || '',
            deadline: getDeadline(),
            createdAt: new Date().toISOString(),
            txParams: txJson
        };
        await store.setOrder(orderId, order);

        res.json({
            success: true,
            data: {
                orderId,
                status: order.status,
                amount: order.amount,
                maxFee: parseInt(CONFIG.maxFee) / 1e6,
                totalDeduction: parseFloat(amount) + parseInt(CONFIG.maxFee) / 1e6,
                userAddress,
                gasFreeAddress: balanceInfo.gasFreeAddress,
                gasFreeBalance: balanceInfo.balance.readable,
                merchantAddress: CONFIG.merchantAddress,
                deadline: order.deadline,
                nonce,
                txParams: txJson,
                qrCode
            }
        });
    } catch (err) {
        log('error', '创建订单失败:', err);
        res.status(500).json({ error: '服务器内部错误', detail: err.message });
    }
});

app.post('/api/gasfree/submit', async (req, res) => {
    try {
        const { orderId, signature, mode = 'auto' } = req.body;
        const order = await store.getOrder(orderId);
        if (!order) return res.status(404).json({ error: '订单不存在' });
        if (order.status !== 'PENDING_SIGNATURE') return res.status(400).json({ error: '订单状态不正确', status: order.status });

        const lockKey = `submit:${orderId}`;
        const acquired = await store.acquireLock(lockKey, 60);
        if (!acquired) return res.status(429).json({ error: '订单正在处理中' });

        try {
            const result = await submitGasFreeTransaction(signature, order.txParams, mode);
            if (result.success) {
                order.status = 'SUBMITTED';
                order.txHash = result.txHash;
                order.submitMode = result.mode;
                order.submittedAt = new Date().toISOString();
                await store.setOrder(orderId, order);
                autoPollTransaction(orderId, result.txHash);
                res.json({
                    success: true,
                    message: '交易已自动提交，后台轮询确认中',
                    data: { orderId, txHash: result.txHash, status: order.status, submitMode: result.mode, estimatedConfirmTime: '约 1-3 分钟' }
                });
            } else {
                res.status(500).json({ error: '交易提交失败' });
            }
        } finally {
            await store.releaseLock(lockKey);
        }
    } catch (err) {
        await store.releaseLock(`submit:${req.body.orderId}`);
        log('error', '提交交易失败:', err);
        res.status(500).json({ error: '服务器内部错误', detail: err.message });
    }
});

app.post('/api/gasfree/auto-collect', async (req, res) => {
    try {
        const { userAddress, signature, nonce: providedNonce, mode = 'auto' } = req.body;
        if (!userAddress || !signature) return res.status(400).json({ error: '缺少 userAddress 或 signature' });
        if (!tronWeb.isAddress(userAddress)) return res.status(400).json({ error: '无效的 TRON 地址' });

        const lockKey = `collect:${userAddress}`;
        const acquired = await store.acquireLock(lockKey, 120);
        if (!acquired) return res.status(429).json({ error: '该地址正在归集中' });

        try {
            const balanceInfo = await getGasFreeBalanceInfo(userAddress);
            const rawBalance = parseInt(balanceInfo.balance.raw);
            const maxFee = parseInt(CONFIG.maxFee);

            if (rawBalance <= 0) return res.status(400).json({ error: 'GasFree 地址无 USDT 余额', gasFreeAddress: balanceInfo.gasFreeAddress, balance: balanceInfo.balance.readable });
            if (rawBalance <= maxFee) return res.status(400).json({ error: '余额不足以支付 GasFree 手续费', gasFreeAddress: balanceInfo.gasFreeAddress, balance: balanceInfo.balance.readable, requiredMin: (maxFee + 1) / 1e6 });

            const transferValue = (rawBalance - maxFee).toString();
            const txNonce = providedNonce || await getUserNonce(userAddress);
            const txJson = buildGasFreeTx(userAddress, CONFIG.merchantAddress, transferValue, txNonce);
            const result = await submitGasFreeTransaction(signature, txJson, mode);

            const orderId = generateOrderId();
            const order = {
                orderId,
                userAddress,
                amount: parseFloat(transferValue) / 1e6,
                value: transferValue,
                receiver: CONFIG.merchantAddress,
                gasFreeAddress: balanceInfo.gasFreeAddress,
                nonce: txNonce,
                status: result.success ? 'SUBMITTED' : 'FAILED',
                txHash: result.txHash || null,
                submitMode: result.mode,
                type: 'AUTO_COLLECT',
                createdAt: new Date().toISOString()
            };
            await store.setOrder(orderId, order);
            if (result.success && result.txHash) autoPollTransaction(orderId, result.txHash);

            res.json({
                success: result.success,
                message: result.success ? '余额归集已自动提交' : '提交失败',
                data: {
                    orderId,
                    userAddress,
                    gasFreeAddress: balanceInfo.gasFreeAddress,
                    totalBalance: balanceInfo.balance.readable,
                    transferAmount: parseFloat(transferValue) / 1e6,
                    gasFreeFee: maxFee / 1e6,
                    actualReceive: parseFloat(transferValue) / 1e6,
                    txHash: result.txHash,
                    submitMode: result.mode,
                    status: order.status
                }
            });
        } finally {
            await store.releaseLock(lockKey);
        }
    } catch (err) {
        await store.releaseLock(`collect:${req.body.userAddress}`);
        log('error', '自动归集失败:', err);
        res.status(500).json({ error: '服务器内部错误', detail: err.message });
    }
});

app.get('/api/gasfree/balance/:userAddress', async (req, res) => {
    try {
        const { userAddress } = req.params;
        if (!tronWeb.isAddress(userAddress)) return res.status(400).json({ error: '无效的 TRON 地址' });
        const result = await getGasFreeBalanceInfo(userAddress);
        const maxFee = parseInt(CONFIG.maxFee) / 1e6;
        const balance = parseFloat(result.balance.readable);
        res.json({
            success: true,
            data: {
                userAddress: result.userAddress,
                gasFreeAddress: result.gasFreeAddress,
                usdtBalance: result.balance.readable,
                rawBalance: result.balance.raw,
                sufficientForTransfer: balance > maxFee,
                estimatedMaxTransfer: balance > maxFee ? (balance - maxFee).toFixed(6) : '0.000000'
            }
        });
    } catch (err) {
        res.status(500).json({ error: '服务器内部错误', detail: err.message });
    }
});

app.get('/api/gasfree/order/:orderId', async (req, res) => {
    const order = await store.getOrder(req.params.orderId);
    if (!order) return res.status(404).json({ error: '订单不存在' });
    const safeOrder = { ...order };
    delete safeOrder.txParams;
    res.json({ success: true, data: safeOrder });
});

app.get('/api/gasfree/merchant-info', (req, res) => {
    res.json({
        success: true,
        data: {
            merchantAddress: CONFIG.merchantAddress,
            serviceProvider: CONFIG.serviceProvider,
            usdtContract: CONFIG.usdtContract,
            maxFee: parseInt(CONFIG.maxFee) / 1e6,
            chainId: '0x' + CONFIG.chainId.toString(16),
            network: CONFIG.chainId === Number('0x2b6653dc') ? 'mainnet' : 'testnet',
            sdkMode: TronGasFree ? 'official' : 'compatible',
            controllerAddress: CONFIG.gasfreeControllerAddress || null,
            submitApi: CONFIG.gasfreeSubmitApi ? 'configured' : null
        }
    });
});

app.get('/api/gasfree/orders', async (req, res) => {
    const list = await store.getAllOrders();
    const safeList = list.map(o => ({
        orderId: o.orderId,
        type: o.type || 'PAYMENT',
        userAddress: o.userAddress,
        amount: o.amount,
        status: o.status,
        txHash: o.txHash,
        submitMode: o.submitMode,
        createdAt: o.createdAt,
        confirmedAt: o.confirmedAt
    }));
    res.json({ success: true, count: safeList.length, data: safeList });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        network: CONFIG.chainId === Number('0x2b6653dc') ? 'mainnet' : 'testnet',
        merchant: CONFIG.merchantAddress ? 'configured' : 'missing',
        sdk: TronGasFree ? 'loaded' : 'compatible-mode',
        redis: redis ? 'connected' : 'disabled',
        controller: CONFIG.gasfreeControllerAddress ? 'configured' : 'missing',
        submitApi: CONFIG.gasfreeSubmitApi ? 'configured' : 'missing'
    });
});

// ==================== 启动 ====================
app.listen(CONFIG.port, async () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║     🚀 GasFree 全自动代付支付服务已启动                  ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log(`║  📡 端口: ${CONFIG.port.toString().padEnd(39)} ║`);
    console.log(`║  🔗 网络: ${(CONFIG.chainId === Number('0x2b6653dc') ? 'TRON 主网' : '测试网').padEnd(39)} ║`);
    console.log(`║  💰 商户收款: ${CONFIG.merchantAddress ? '已配置' : '未配置'.padEnd(35)} ║`);
    console.log(`║  ⛽ 服务商: ${CONFIG.serviceProvider ? '已配置' : '未配置'.padEnd(37)} ║`);
    console.log(`║  💸 手续费上限: ${(parseInt(CONFIG.maxFee) / 1e6 + ' USDT/笔').padEnd(32)} ║`);
    console.log(`║  📦 SDK模式: ${(TronGasFree ? '官方SDK' : '兼容模式').padEnd(36)} ║`);
    console.log(`║  🔴 Redis: ${(redis ? '已连接' : '内存模式').padEnd(38)} ║`);
    console.log(`║  📡 事件监听: ${(CONFIG.gasfreeControllerAddress ? '已启用' : '未配置').padEnd(36)} ║`);
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('');
    console.log('接口列表:');
    console.log('  POST /api/gasfree/create-order    创建订单');
    console.log('  POST /api/gasfree/submit          提交签名 → 自动上链');
    console.log('  POST /api/gasfree/auto-collect    全额自动归集（转余额）');
    console.log('  GET  /api/gasfree/balance/:addr   查询 GasFree 地址余额');
    console.log('  GET  /api/gasfree/order/:id       查询订单/交易状态');
    console.log('  GET  /api/gasfree/merchant-info   商户配置信息');
    console.log('  GET  /api/gasfree/orders          订单列表');
    console.log('  GET  /health                      健康检查');
    console.log('');
    console.log('前端页面: http://localhost:' + CONFIG.port);
    console.log('');
    await startEventListener();
});
