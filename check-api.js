#!/usr/bin/env node
/**
 * API Key 有效性检测脚本
 * 检测 TronGrid API Key 和 GasFree API 配置是否正确
 */

require('dotenv').config();
const axios = require('axios');
const TronWeb = require('tronweb');

const CONFIG = {
    fullHost: process.env.FULL_HOST || 'https://api.trongrid.io',
    trongridApiKey: process.env.TRONGRID_API_KEY || '',
    gasfreeSubmitApi: process.env.GASFREE_SUBMIT_API || '',
    gasfreeApiKey: process.env.GASFREE_API_KEY || '',
    gasfreeApiSecret: process.env.GASFREE_API_SECRET || '',
    gasfreeControllerAddress: process.env.GASFREE_CONTROLLER_ADDRESS || '',
    merchantAddress: process.env.MERCHANT_ADDRESS || '',
    serviceProvider: process.env.SERVICE_PROVIDER || '',
    privateKey: process.env.PRIVATE_KEY || '',
    usdtContract: process.env.USDT_CONTRACT || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
};

const tronWeb = new TronWeb({
    fullHost: CONFIG.fullHost,
    headers: CONFIG.trongridApiKey ? { 'TRON-PRO-API-KEY': CONFIG.trongridApiKey } : {}
});

console.log('🔍 API Key 有效性检测');
console.log('====================\n');

// 1. 检测环境变量
console.log('📋 环境变量检查');
console.log('----------------');
const requiredVars = ['MERCHANT_ADDRESS', 'SERVICE_PROVIDER', 'PRIVATE_KEY'];
const optionalVars = ['TRONGRID_API_KEY', 'GASFREE_API_KEY', 'GASFREE_API_SECRET', 'GASFREE_SUBMIT_API', 'GASFREE_CONTROLLER_ADDRESS'];

let hasError = false;

for (const key of requiredVars) {
    const value = process.env[key];
    if (!value || value.includes('...') || value.includes('your') || value.includes('待填')) {
        console.log(`❌ ${key}: 未填写或无效`);
        hasError = true;
    } else {
        const display = key === 'PRIVATE_KEY' 
            ? value.slice(0, 6) + '...' + value.slice(-6) 
            : value.slice(0, 20) + '...';
        console.log(`✅ ${key}: ${display}`);
    }
}

for (const key of optionalVars) {
    const value = process.env[key];
    if (!value || value.includes('your') || value.includes('待填')) {
        console.log(`⚠️  ${key}: 未配置（将使用降级方案）`);
    } else {
        console.log(`✅ ${key}: 已配置`);
    }
}

console.log('');

// 2. 检测地址格式
console.log('📍 地址格式检查');
console.log('----------------');

function checkAddress(address, name) {
    if (!address) {
        console.log(`❌ ${name}: 为空`);
        return false;
    }
    if (!tronWeb.isAddress(address)) {
        console.log(`❌ ${name}: 格式无效 (${address})`);
        return false;
    }
    console.log(`✅ ${name}: 格式正确 (${address.slice(0, 8)}...${address.slice(-6)})`);
    return true;
}

checkAddress(CONFIG.merchantAddress, 'MERCHANT_ADDRESS');
checkAddress(CONFIG.serviceProvider, 'SERVICE_PROVIDER');
checkAddress(CONFIG.gasfreeControllerAddress, 'GASFREE_CONTROLLER_ADDRESS');
checkAddress(CONFIG.usdtContract, 'USDT_CONTRACT');

console.log('');

// 3. 检测 TronGrid API Key
console.log('🌐 TronGrid API Key 检测');
console.log('------------------------');

async function checkTronGrid() {
    if (!CONFIG.trongridApiKey) {
        console.log('⚠️  TRONGRID_API_KEY 未配置');
        console.log('   将使用无 Key 模式（可能限流）');
        return;
    }

    try {
        const response = await axios.get(`${CONFIG.fullHost}/wallet/getnowblock`, {
            headers: { 'TRON-PRO-API-KEY': CONFIG.trongridApiKey },
            timeout: 10000
        });

        if (response.data && response.data.block_header) {
            const blockNum = response.data.block_header.raw_data.number;
            console.log(`✅ TronGrid API Key 有效`);
            console.log(`   当前区块高度: ${blockNum}`);
        } else {
            console.log(`⚠️  TronGrid 响应异常，Key 可能无效`);
        }
    } catch (err) {
        if (err.response && err.response.status === 403) {
            console.log(`❌ TronGrid API Key 无效或已过期 (403)`);
            console.log(`   请访问 https://www.trongrid.io/ 重新申请`);
        } else if (err.response && err.response.status === 429) {
            console.log(`⚠️  TronGrid 请求过于频繁 (429)`);
            console.log(`   Key 可能有效，但已触发限流`);
        } else {
            console.log(`❌ TronGrid 检测失败: ${err.message}`);
        }
    }
}

// 4. 检测 GasFree API
console.log('⛽ GasFree API 检测');
console.log('-------------------');

async function checkGasFree() {
    if (!CONFIG.gasfreeSubmitApi && !CONFIG.gasfreeControllerAddress) {
        console.log('⚠️  GasFree 未配置，将使用模拟模式');
        return;
    }

    if (CONFIG.gasfreeSubmitApi) {
        try {
            const response = await axios.get(CONFIG.gasfreeSubmitApi.replace(/\/$/, '') + '/health', {
                headers: CONFIG.gasfreeApiKey ? { 'X-API-Key': CONFIG.gasfreeApiKey } : {},
                timeout: 10000
            });
            console.log(`✅ GasFree API 地址可访问`);
            console.log(`   状态: ${response.status}`);
        } catch (err) {
            if (err.response) {
                console.log(`⚠️  GasFree API 返回 ${err.response.status}`);
                console.log(`   Key 可能无效或 API 路径错误`);
            } else {
                console.log(`❌ GasFree API 无法连接: ${err.message}`);
                console.log(`   请检查网络或 API 地址`);
            }
        }
    }

    if (CONFIG.gasfreeControllerAddress) {
        try {
            const code = await tronWeb.trx.getContract(CONFIG.gasfreeControllerAddress);
            if (code && code.bytecode && code.bytecode.length > 2) {
                console.log(`✅ GasFree Controller 合约存在`);
                console.log(`   合约地址: ${CONFIG.gasfreeControllerAddress.slice(0, 8)}...`);
            } else {
                console.log(`⚠️  GasFree Controller 合约可能未部署`);
            }
        } catch (err) {
            console.log(`❌ 无法读取 Controller 合约: ${err.message}`);
        }
    }
}

// 5. 检测私钥和余额
console.log('🔑 私钥 & 余额检测');
console.log('-------------------');

async function checkPrivateKey() {
    if (!CONFIG.privateKey || CONFIG.privateKey.includes('...')) {
        console.log('❌ PRIVATE_KEY 未配置');
        return;
    }

    try {
        const tronWebWithKey = new TronWeb({
            fullHost: CONFIG.fullHost,
            privateKey: CONFIG.privateKey,
            headers: CONFIG.trongridApiKey ? { 'TRON-PRO-API-KEY': CONFIG.trongridApiKey } : {}
        });

        const address = tronWebWithKey.defaultAddress.base58;
        console.log(`✅ 私钥有效`);
        console.log(`   对应地址: ${address}`);

        // 查询 TRX 余额
        const balance = await tronWebWithKey.trx.getBalance(address);
        const trxBalance = balance / 1e6;
        console.log(`   TRX 余额: ${trxBalance} TRX`);

        if (trxBalance < 1) {
            console.log(`⚠️  TRX 余额较低，可能无法支付合约调用费用`);
        }

        // 查询 USDT 余额
        try {
            const contract = await tronWebWithKey.contract().at(CONFIG.usdtContract);
            const usdtBalance = await contract.balanceOf(address).call();
            console.log(`   USDT 余额: ${usdtBalance / 1e6} USDT`);
        } catch (e) {
            console.log(`⚠️  无法查询 USDT 余额`);
        }

    } catch (err) {
        console.log(`❌ 私钥无效: ${err.message}`);
    }
}

// 6. 综合建议
console.log('');
console.log('📊 综合评估');
console.log('-----------');

function printSuggestions() {
    const suggestions = [];

    if (!CONFIG.trongridApiKey) {
        suggestions.push('• 申请 TronGrid API Key: https://www.trongrid.io/');
    }

    if (!CONFIG.gasfreeApiKey && !CONFIG.gasfreeControllerAddress) {
        suggestions.push('• 配置 GasFree Controller 合约地址或申请 GasFree API');
    }

    if (!CONFIG.gasfreeControllerAddress) {
        suggestions.push('• 确认 Controller 地址: TFFAMLQZybALab4uxHA9RBE7pxhUAjfF3U');
    }

    if (CONFIG.merchantAddress === CONFIG.gasfreeControllerAddress) {
        suggestions.push('• ❌ 严重: MERCHANT_ADDRESS 和 CONTROLLER_ADDRESS 相同！');
    }

    if (suggestions.length === 0) {
        console.log('✅ 所有配置看起来正常，可以启动服务');
    } else {
        console.log('建议操作:');
        suggestions.forEach(s => console.log(s));
    }
}

// 执行所有检测
(async () => {
    await checkTronGrid();
    console.log('');
    await checkGasFree();
    console.log('');
    await checkPrivateKey();
    console.log('');
    printSuggestions();

    console.log('');
    console.log('====================');
    console.log('检测完成');
})();
