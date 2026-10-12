# 幽灵信匿名中继（自建部署）

一条命令部署你自己的中继。中继只存密文、GET 即焚、无日志（代码 200 行可全文审计）。

```bash
cd relay
npm i -g wrangler   # Cloudflare 官方 CLI
wrangler login
wrangler kv namespace create BOX      # 输出 id 填入 wrangler.toml
wrangler deploy
```

部署后得到 `https://linkto-ghost-relay.<你的子域>.workers.dev`，
在应用「幽灵信箱 → ⚙ 设置 → 中继地址」填入该地址即可启用中继通道。

## 伪装模型

| 网关可见 | 网关不可见 |
|---|---|
| 一条到 `*.workers.dev` 的普通 HTTPS POST/GET | 收发件人、主题、正文（全密文） |
| JSON 字段：client/item/folder/content/meta | folder = 收件人随机公钥哈希（不关联身份） |
| 请求大小随机波动（256-2KB 填充） | 这是邮件 |

## 端点

- `POST /api/v1/items` — `{item:{folder,content,pad}}` 投递密文（≤128KB，folder 积压 ≤32 封）
- `GET /api/v1/items?folder=<16hex>` — 一次性取走并立即删除

## 诚实边界

- TLS 指纹层面 `workers.dev` 与普通 Cloudflare 站点一致；但"访问了 Cloudflare"这一事实网关可见
- 中继运营方（Cloudflare / 自建者）能看到密文与 folder 键，无法解内容也无法关联身份
- 72 小时未取自动焚毁；塞柜滥用以 429 拒绝