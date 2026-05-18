#!/bin/bash
set -e

echo "🚀 GasFree Payment - Git 仓库初始化脚本"
echo "=========================================="

# 检查是否已初始化
if [ -d .git ]; then
    echo "⚠️  Git 仓库已存在，跳过初始化"
else
    echo "📦 初始化 Git 仓库..."
    git init
    git branch -M main
fi

# 配置（可选，如未全局设置）
read -p "请输入 Git 用户名（留空使用全局配置）: " git_name
read -p "请输入 Git 邮箱（留空使用全局配置）: " git_email

if [ ! -z "$git_name" ]; then
    git config user.name "$git_name"
fi
if [ ! -z "$git_email" ]; then
    git config user.email "$git_email"
fi

# 添加远程仓库
read -p "请输入 GitHub 仓库地址 (如: https://github.com/username/repo.git): " repo_url

if [ ! -z "$repo_url" ]; then
    git remote remove origin 2>/dev/null || true
    git remote add origin "$repo_url"
    echo "✅ 远程仓库已添加: $repo_url"
else
    echo "⚠️  未输入仓库地址，稍后请手动添加:"
    echo "   git remote add origin https://github.com/username/repo.git"
fi

# 首次提交
echo "📤 提交代码..."
git add .
git commit -m "feat: GasFree 全自动代付支付服务

- 支持 TIP-712 签名免 TRX 支付
- 全自动上链 + 事件监听/轮询双保险
- 余额自动归集（转余额）
- 三级提交降级: API -> 合约 -> 模拟
- Redis 持久化存储支持
- 完整前端支付页面"

# 推送
if [ ! -z "$repo_url" ]; then
    echo "☁️  推送到 GitHub..."
    git push -u origin main
    echo "✅ 推送完成！"
else
    echo ""
    echo "后续步骤:"
    echo "1. 在 GitHub 创建空仓库（不要初始化 README）"
    echo "2. 运行: git remote add origin <你的仓库地址>"
    echo "3. 运行: git push -u origin main"
fi

echo ""
echo "🎉 完成！"
