# GasFree 全自动代付支付服务

基于 TRON 链的 GasFree 机制，实现用户 **无需持有 TRX** 即可使用 USDT 完成支付，并支持余额 **全自动归集**。

## 核心特性

- ✅ **免 TRX 支付**：用户只需 USDT，Gas 费由服务商代付
- ✅ **全自动上链**：签名后服务端自动提交交易并轮询确认
- ✅ **余额自动归集**：一键将 GasFree 地址全部 USDT 扣除手续费后转入商户
- ✅ **TIP-712 签名**：兼容 TronLink 结构化数据签名
- ✅ **二维码支付**：支持扫码唤起钱包支付
- ✅ **TronGrid 事件监听**：替代轮询，实时确认交易
- ✅ **Redis 存储**：生产环境支持持久化存储
- ✅ **三级提交降级**：服务商 API → 合约调用 → 模拟模式

## 项目结构

```
gasfree-payment/
├── server.js                    # 主服务端
├── package.json                 # 依赖配置
├── .env                         # 环境变量
├── .env.example                 # 环境变量模板
├── abi/
│   ├── GasFreeController.json   # GasFree 控制器合约 ABI
│   └── USDT.json               # USDT TRC20 合约 ABI
└── public/
    └── index.html              # 前端支付页面
```

## 快速开始

### 1. 安装依赖

```bash
cd ~/ai-video-maker/gasfree-payment
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
nano .env
```

### 3. 启动服务

```bash
npm start
# 或开发模式
npm run dev
```

访问 `http://localhost:3000` 即可使用。

## 关键配置

| 变量 | 说明 | 主网值 |
|------|------|--------|
| `CHAIN_ID` | 链 ID | `0x2b6653dc` (728126428) |
| `FULL_HOST` | TRON 节点 | `https://api.trongrid.io` |
| `SERVICE_PROVIDER` | GasFree 服务商 | `TLyqzVGLV1srkB7dToTAEqgDSfPtXRJZYH` |
| `GASFREE_SUBMIT_API` | 服务商 API | `https://open.gasfree.io/tron/` |
| `GASFREE_CONTROLLER_ADDRESS` | 合约地址 | `TFFAMLQZybALab4uxHA9RBE7pxhUAjfF3U` |
| `USDT_CONTRACT` | USDT 合约 | `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` |

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/gasfree/create-order` | 创建支付订单 |
| POST | `/api/gasfree/submit` | 提交签名并自动上链 |
| POST | `/api/gasfree/auto-collect` | 全额自动归集 |
| GET | `/api/gasfree/balance/:addr` | 查询 GasFree 地址余额 |
| GET | `/api/gasfree/order/:id` | 查询订单状态 |
| GET | `/api/gasfree/merchant-info` | 商户配置信息 |
| GET | `/api/gasfree/orders` | 订单列表 |
| GET | `/health` | 健康检查 |

## 工作流程

### 普通支付流程

1. 用户在前端输入金额 → 调用 `create-order`
2. 服务端返回 TIP-712 签名参数 + 二维码
3. 用户使用 TronLink 签名结构化数据
4. 前端将签名发送到 `submit`
5. 服务端自动提交到 GasFree 服务商/合约
6. **TronGrid 事件监听** + 后台轮询双保险确认

### 余额归集流程

1. 用户查询 GasFree 地址余额
2. 前端自动计算可全额转出金额（余额 - 手续费）
3. 用户一键签名
4. 服务端提交归集交易
5. 全部 USDT 自动转入商户地址

## 三种提交模式

服务端 `submitGasFreeTransaction` 支持自动降级：

1. **服务商 API 模式**：优先调用 `GASFREE_SUBMIT_API`
2. **合约调用模式**：直接调用 `GASFREE_CONTROLLER_ADDRESS` 合约 `executeGasFreeTransfer`
3. **模拟模式**：无配置时返回模拟交易（仅开发测试）

## 安全提示

- ⚠️ **私钥安全**：`PRIVATE_KEY` 拥有提交交易权限，生产环境务必使用 KMS
- ⚠️ **Nonce 管理**：优先从链上 GasFree Controller 合约读取，避免重放攻击
- ⚠️ **GasFree 地址**：必须使用官方算法生成，兼容模式仅供开发测试
- ⚠️ **防重入锁**：已内置分布式锁防止重复提交

## 生产环境建议

1. 启用 **Redis** 持久化存储
2. 使用 **TronGrid API Key** 避免节点限流
3. 接入真实的 **GasFree 服务商 API** 或部署官方 Controller 合约
4. 配置 **Webhook** 接收链上事件
5. 启用 **HTTPS + CORS 白名单**
6. 添加 **请求频率限制（Rate Limiting）**# usdt
