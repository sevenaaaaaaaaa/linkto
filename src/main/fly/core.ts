import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  pbkdf2Sync,
  randomBytes,
  timingSafeEqual
} from 'node:crypto'

/**
 * 萤火密信 v2 —— 一次性、无身份、可离线验证的端到端密文
 *
 * 设计目标（对应 2026-10 产品反馈）：
 *  1. 不依赖任何长期身份：没有账号、没有邮箱、没有设备私钥、没有公钥目录。
 *     唯一的“身份”是一封密信自己的随机信箱号（16B），用完即弃，无法关联第二封。
 *  2. 三条知识路径都成立才可读：
 *     - 链接模式：32B 随机密钥只存在于 URL fragment（浏览器/应用都不会发给服务器）
 *     - 链接 + 口令：链接只带信箱号，6 词口令另行口头/当面传递，两条信道缺一不可
 *     - 纯口令：6 词口令同时决定信箱号与密钥，收件人只需一个网址 + 6 个词
 *  3. 抗离线暴力：口令是 CSPRNG 生成的 6 个 BIP39 词（66 bit），并非用户自选弱密码；
 *     PBKDF2-SHA256 600k 迭代把单次猜测成本抬到 0.1s 量级，2^66 次猜测不可行。
 *     （用户自选密码/短口令不再被接受 —— 这是 v1 最薄的一层。）
 *  4. 元数据最小化：正文按固定档位填充后再加密，密文长度只泄露“档位”；
 *     密文头部字段全部纳入 AEAD 关联数据，篡改信箱号/有效期会直接解密失败。
 *  5. 时间边界：信封内 exp 由 AEAD 保护，客户端拒绝过期信；服务端同时按 TTL 删除。
 *     真正的“当时当刻”由服务端读后即焚 + 客户端只在内存中解密共同保证。
 *
 * 这里不实现“阅后即焚”的存储逻辑，只提供可独立测试的密码学核心。
 */

export const FLY_APP = 'linkto-fly'
export const FLY_VERSION = 2

/** 口令词数（BIP39 2048 词表，6 词 = 66 bit） */
export const CODE_WORDS = 6

/** PBKDF2-SHA256 迭代次数（与浏览器 WebCrypto 参数一致） */
export const PBKDF2_ITERATIONS = 600_000

/** 纯口令模式固定的 KDF salt；口令本身是 66 bit 随机，跨消息预计算没有意义 */
const CODE_SALT = Buffer.from('linkto-fly/code/v2', 'utf8')

/** 由密钥派生信箱号的域分离标签 */
const MBOX_LABEL = 'linkto-fly/mbox/v2'

export const MIN_TTL_SECONDS = 60
export const MAX_TTL_SECONDS = 7 * 24 * 3600

/** 正文填充档位：密文长度只暴露所属档位，不暴露真实长度 */
const BUCKETS = [256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 49152]
const MAX_PLAINTEXT_BYTES = 40_000

export type FlyMode = 'link' | 'link-code' | 'code'

export interface FlyEnvelopeHeader {
  app: typeof FLY_APP
  v: typeof FLY_VERSION
  /** 打开方式：link=链接自带密钥 / link-code=链接+口令 / code=纯口令 */
  m: FlyMode
  /** 随机信箱号（16B hex，32 字符），与任何现实身份无关 */
  mb: string
  /** link-code 模式的 KDF salt（base64url）；其余模式省略 */
  s?: string
  /** AES-GCM nonce（base64url） */
  i: string
  /** 密文（base64） */
  c: string
  /** GCM tag（base64） */
  t: string
  /** 封装时间（毫秒） */
  iat: number
  /** 有效期（秒） */
  ttl: number
}

export interface SealedFly {
  /** 完整信封 JSON，可投放中继或作为文件传输 */
  envelope: string
  mode: FlyMode
  mbox: string
  /** link 模式的 32B 密钥（base64url），放进 URL fragment */
  keyB64?: string
  /** 口令模式的 6 个词 */
  code?: string
  expiresAt: number
}

export interface OpenFlyOptions {
  keyB64?: string
  code?: string
  /** 便于测试注入时间 */
  now?: number
}

export type FlyErrorCode =
  | 'bad-input'
  | 'bad-envelope'
  | 'wrong-code'
  | 'tampered'
  | 'expired'
  | 'too-long'
  | 'missing-secret'

export class FlyError extends Error {
  readonly code: FlyErrorCode
  constructor(code: FlyErrorCode, message: string) {
    super(message)
    this.name = 'FlyError'
    this.code = code
  }
}

export interface FlyLinkParts {
  base: string
  mbox: string
  keyB64?: string
  needsCode: boolean
}

// ---------------------------------------------------------------------------
// 编码工具
// ---------------------------------------------------------------------------

function b64u(buf: Buffer): string {
  return buf.toString('base64url')
}

function fromB64u(s: string): Buffer {
  return Buffer.from(s, 'base64url')
}

function hex(buf: Buffer): string {
  return buf.toString('hex')
}

const MBOX_RE = /^[0-9a-f]{32}$/

export function isMbox(s: string): boolean {
  return MBOX_RE.test(s)
}

/**
 * 规范化口令：大小写、全角、空格、连字符、中英文标点都不影响结果。
 * 用户从聊天软件里复制来的 “Apple - River ，Stone” 与 “apple river stone” 等价。
 */
export function normalizeCode(input: string): string {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .split(/[\s\-_,，、.;；:：/|]+/)
    .filter(Boolean)
    .join(' ')
}

/** 6 个 BIP39 词的形状（不校验是否真的在词表里，用于 UI 识别） */
export function looksLikeCode(input: string): boolean {
  const parts = normalizeCode(input).split(' ').filter(Boolean)
  return parts.length === CODE_WORDS
}

export function generateCode(): string {
  const words: string[] = []
  for (let i = 0; i < CODE_WORDS; i++) {
    // 2048 整除采样，无模偏
    const n = randomBytes(2).readUInt16BE(0) & 0x7ff
    words.push(WORDS[n])
  }
  return words.join(' ')
}

export function deriveKeyFromCode(code: string, salt: Buffer): Buffer {
  return pbkdf2Sync(normalizeCode(code), salt, PBKDF2_ITERATIONS, 32, 'sha256')
}

/** 纯口令模式：由密钥确定性地派生信箱号（同一口令 = 同一信箱） */
export function mboxForKey(key: Buffer): string {
  return createHmac('sha256', key).update(MBOX_LABEL).digest('hex').slice(0, 32)
}

export function mboxForCode(code: string): string {
  return mboxForKey(deriveKeyFromCode(code, CODE_SALT))
}

// ---------------------------------------------------------------------------
// 信封
// ---------------------------------------------------------------------------

function clampTtl(ttlSeconds: number): number {
  if (!Number.isFinite(ttlSeconds)) return 3600
  return Math.max(MIN_TTL_SECONDS, Math.min(MAX_TTL_SECONDS, Math.floor(ttlSeconds)))
}

function aadOf(h: Pick<FlyEnvelopeHeader, 'm' | 'mb' | 's' | 'iat' | 'ttl'>): Buffer {
  return Buffer.from(
    [FLY_APP, String(FLY_VERSION), h.m, h.mb, h.s ?? '', String(h.iat), String(h.ttl)].join('|'),
    'utf8'
  )
}

function padToBucket(text: string, exp: number): Buffer {
  const base = JSON.stringify({ t: text, exp, p: '' })
  const baseBytes = Buffer.byteLength(base, 'utf8')
  if (baseBytes + 16 > BUCKETS[BUCKETS.length - 1] || baseBytes > MAX_PLAINTEXT_BYTES) {
    throw new FlyError('too-long', '正文过长（上限约 40KB）')
  }
  const target = BUCKETS.find(b => b >= baseBytes + 16)!
  const padChars = target - baseBytes
  const padding = randomBytes(Math.ceil(padChars / 2)).toString('hex').slice(0, padChars)
  const padded = JSON.stringify({ t: text, exp, p: padding })
  const out = Buffer.from(padded, 'utf8')
  if (out.length !== target) {
    // p 是纯 hex，不应触发；留作断言，避免填充失效后静默泄露长度
    throw new FlyError('bad-envelope', '信封填充长度异常')
  }
  return out
}

export interface SealOptions {
  mode: FlyMode
  ttlSeconds: number
  now?: number
}

/**
 * 封装一封密信。口令模式会现场生成 6 词口令，绝不接受调用方自选的弱口令。
 */
export function seal(text: string, opts: SealOptions): SealedFly {
  if (typeof text !== 'string' || text.length === 0) throw new FlyError('bad-input', '正文为空')
  const mode = opts.mode
  if (mode !== 'link' && mode !== 'link-code' && mode !== 'code') {
    throw new FlyError('bad-input', '未知的打开方式')
  }
  const now = opts.now ?? Date.now()
  const ttl = clampTtl(opts.ttlSeconds)
  const exp = now + ttl * 1000

  let key: Buffer
  let keyB64: string | undefined
  let code: string | undefined
  let salt: Buffer | undefined
  let mbox: string

  if (mode === 'link') {
    key = randomBytes(32)
    keyB64 = b64u(key)
    mbox = hex(randomBytes(16))
  } else if (mode === 'link-code') {
    code = generateCode()
    salt = randomBytes(16)
    key = deriveKeyFromCode(code, salt)
    mbox = hex(randomBytes(16))
  } else {
    code = generateCode()
    key = deriveKeyFromCode(code, CODE_SALT)
    mbox = mboxForKey(key)
  }

  const header: FlyEnvelopeHeader = {
    app: FLY_APP,
    v: FLY_VERSION,
    m: mode,
    mb: mbox,
    ...(salt ? { s: b64u(salt) } : {}),
    i: '',
    c: '',
    t: '',
    iat: now,
    ttl
  }

  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aadOf(header))
  const ct = Buffer.concat([cipher.update(padToBucket(text, exp)), cipher.final()])
  header.i = b64u(iv)
  header.c = ct.toString('base64')
  header.t = cipher.getAuthTag().toString('base64')

  return {
    envelope: JSON.stringify(header),
    mode,
    mbox,
    ...(keyB64 ? { keyB64 } : {}),
    ...(code ? { code } : {}),
    expiresAt: exp
  }
}

export interface OpenedFly {
  text: string
  mode: FlyMode
  mbox: string
  expiresAt: number
}

function parseHeader(envelopeJson: string): FlyEnvelopeHeader {
  let raw: unknown
  try {
    raw = JSON.parse(envelopeJson)
  } catch {
    throw new FlyError('bad-envelope', '不是有效的密信信封')
  }
  const h = raw as Partial<FlyEnvelopeHeader>
  if (!h || h.app !== FLY_APP || h.v !== FLY_VERSION) throw new FlyError('bad-envelope', '不是有效的密信信封')
  if (h.m !== 'link' && h.m !== 'link-code' && h.m !== 'code') throw new FlyError('bad-envelope', '未知的打开方式')
  if (typeof h.mb !== 'string' || !MBOX_RE.test(h.mb)) throw new FlyError('bad-envelope', '信箱号异常')
  if (typeof h.i !== 'string' || typeof h.c !== 'string' || typeof h.t !== 'string') {
    throw new FlyError('bad-envelope', '信封字段缺失')
  }
  if (!Number.isFinite(h.iat) || !Number.isFinite(h.ttl)) throw new FlyError('bad-envelope', '信封时间异常')
  if (h.m === 'link-code' && (typeof h.s !== 'string' || h.s.length === 0)) {
    throw new FlyError('bad-envelope', '口令信封缺少 salt')
  }
  return h as FlyEnvelopeHeader
}

/** 只读信封头部（不碰密钥），用于 UI 显示有效期/大小 */
export function inspectEnvelope(envelopeJson: string): { mode: FlyMode; mbox: string; iat: number; ttl: number; expiresAt: number; bytes: number } {
  const h = parseHeader(envelopeJson)
  return { mode: h.m, mbox: h.mb, iat: h.iat, ttl: h.ttl, expiresAt: h.iat + h.ttl * 1000, bytes: Buffer.byteLength(envelopeJson) }
}

/**
 * 打开一封密信。口令错误与密文被篡改都只返回同一种失败，不提供可用于
 * 离线区分“口令对不对”的旁路信息（GCM tag 是唯一判据，且必须持有信封）。
 */
export function open(envelopeJson: string, opts: OpenFlyOptions): OpenedFly {
  const h = parseHeader(envelopeJson)
  const now = opts.now ?? Date.now()

  let key: Buffer
  if (h.m === 'link') {
    if (!opts.keyB64) throw new FlyError('missing-secret', '缺少链接密钥')
    key = fromB64u(opts.keyB64)
    if (key.length !== 32) throw new FlyError('missing-secret', '链接密钥长度异常')
  } else if (h.m === 'link-code') {
    if (!opts.code) throw new FlyError('missing-secret', '需要 6 词口令')
    key = deriveKeyFromCode(opts.code, Buffer.from(h.s!, 'base64url'))
  } else {
    if (!opts.code) throw new FlyError('missing-secret', '需要 6 词口令')
    key = deriveKeyFromCode(opts.code, CODE_SALT)
    const expected = Buffer.from(mboxForKey(key), 'hex')
    const actual = Buffer.from(h.mb, 'hex')
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new FlyError('wrong-code', '口令不对，或密信已被读取焚毁')
    }
  }

  let plaintext: Buffer
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(h.i, 'base64url'))
    decipher.setAAD(aadOf(h))
    decipher.setAuthTag(Buffer.from(h.t, 'base64'))
    plaintext = Buffer.concat([decipher.update(Buffer.from(h.c, 'base64')), decipher.final()])
  } catch {
    throw new FlyError('wrong-code', '口令不对，或密信已被读取焚毁')
  }

  let payload: { t?: unknown; exp?: unknown }
  try {
    payload = JSON.parse(plaintext.toString('utf8')) as { t?: unknown; exp?: unknown }
  } catch {
    throw new FlyError('tampered', '密信内容已损坏')
  }
  if (typeof payload.t !== 'string' || typeof payload.exp !== 'number') {
    throw new FlyError('tampered', '密信内容已损坏')
  }
  if (payload.exp <= now) throw new FlyError('expired', '密信已过期并焚毁')
  // 头部 ttl 与内部 exp 必须一致（AAD 已绑定，这里防的是实现分叉）
  if (Math.abs(payload.exp - (h.iat + h.ttl * 1000)) > 1000) {
    throw new FlyError('tampered', '密信有效期不一致')
  }

  plaintext.fill(0)
  key.fill(0)
  return { text: payload.t, mode: h.m, mbox: h.mb, expiresAt: payload.exp }
}

// ---------------------------------------------------------------------------
// 链接解析
// ---------------------------------------------------------------------------

/**
 * 解析应用链接：https://<relay>/r/<mbox>#k=<key>（仅链接）
 *                 https://<relay>/r/<mbox>#c     （链接 + 口令）
 * 也接受裸的 32 位信箱号（配合口令）。
 */
export function parseFlyLink(input: string): FlyLinkParts | null {
  const s = input.trim()
  if (isMbox(s)) return { base: '', mbox: s, needsCode: true }

  let url: URL
  try {
    url = new URL(s)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const parts = url.pathname.split('/').filter(Boolean)
  const idx = parts.indexOf('r')
  const mbox = idx >= 0 ? parts[idx + 1] : parts[parts.length - 1]
  if (!mbox || !isMbox(mbox)) return null
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''))
  const keyB64 = hash.get('k') ?? undefined
  if (keyB64) {
    if (fromB64u(keyB64).length !== 32) return null
    return { base: url.origin, mbox, keyB64, needsCode: false }
  }
  return { base: url.origin, mbox, needsCode: true }
}

/** 生成对外分享的链接（密钥永远只在 fragment 里） */
export function flyLink(base: string, sealed: SealedFly): string {
  const root = base.replace(/\/+$/, '')
  if (sealed.mode === 'link') return root + '/r/' + sealed.mbox + '#k=' + sealed.keyB64
  return root + '/r/' + sealed.mbox + '#c'
}

// ---------------------------------------------------------------------------
// BIP39 英文词表（2048 词，6 词 = 66 bit）
// ---------------------------------------------------------------------------

const WORDS_RAW = "abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual adapt add addict address adjust admit adult advance advice aerobic affair afford afraid again age agent agree ahead aim air airport aisle alarm album alcohol alert alien all alley allow almost alone alpha already also alter always amateur amazing among amount amused analyst anchor ancient anger angle angry animal ankle announce annual another answer antenna antique anxiety any apart apology appear apple approve april arch arctic area arena argue arm armed armor army around arrange arrest arrive arrow art artefact artist artwork ask aspect assault asset assist assume asthma athlete atom attack attend attitude attract auction audit august aunt author auto autumn average avocado avoid awake aware away awesome awful awkward axis baby bachelor bacon badge bag balance balcony ball bamboo banana banner bar barely bargain barrel base basic basket battle beach bean beauty because become beef before begin behave behind believe below belt bench benefit best betray better between beyond bicycle bid bike bind biology bird birth bitter black blade blame blanket blast bleak bless blind blood blossom blouse blue blur blush board boat body boil bomb bone bonus book boost border boring borrow boss bottom bounce box boy bracket brain brand brass brave bread breeze brick bridge brief bright bring brisk broccoli broken bronze broom brother brown brush bubble buddy budget buffalo build bulb bulk bullet bundle bunker burden burger burst bus business busy butter buyer buzz cabbage cabin cable cactus cage cake call calm camera camp can canal cancel candy cannon canoe canvas canyon capable capital captain car carbon card cargo carpet carry cart case cash casino castle casual cat catalog catch category cattle caught cause caution cave ceiling celery cement census century cereal certain chair chalk champion change chaos chapter charge chase chat cheap check cheese chef cherry chest chicken chief child chimney choice choose chronic chuckle chunk churn cigar cinnamon circle citizen city civil claim clap clarify claw clay clean clerk clever click client cliff climb clinic clip clock clog close cloth cloud clown club clump cluster clutch coach coast coconut code coffee coil coin collect color column combine come comfort comic common company concert conduct confirm congress connect consider control convince cook cool copper copy coral core corn correct cost cotton couch country couple course cousin cover coyote crack cradle craft cram crane crash crater crawl crazy cream credit creek crew cricket crime crisp critic crop cross crouch crowd crucial cruel cruise crumble crunch crush cry crystal cube culture cup cupboard curious current curtain curve cushion custom cute cycle dad damage damp dance danger daring dash daughter dawn day deal debate debris decade december decide decline decorate decrease deer defense define defy degree delay deliver demand demise denial dentist deny depart depend deposit depth deputy derive describe desert design desk despair destroy detail detect develop device devote diagram dial diamond diary dice diesel diet differ digital dignity dilemma dinner dinosaur direct dirt disagree discover disease dish dismiss disorder display distance divert divide divorce dizzy doctor document dog doll dolphin domain donate donkey donor door dose double dove draft dragon drama drastic draw dream dress drift drill drink drip drive drop drum dry duck dumb dune during dust dutch duty dwarf dynamic eager eagle early earn earth easily east easy echo ecology economy edge edit educate effort egg eight either elbow elder electric elegant element elephant elevator elite else embark embody embrace emerge emotion employ empower empty enable enact end endless endorse enemy energy enforce engage engine enhance enjoy enlist enough enrich enroll ensure enter entire entry envelope episode equal equip era erase erode erosion error erupt escape essay essence estate eternal ethics evidence evil evoke evolve exact example excess exchange excite exclude excuse execute exercise exhaust exhibit exile exist exit exotic expand expect expire explain expose express extend extra eye eyebrow fabric face faculty fade faint faith fall false fame family famous fan fancy fantasy farm fashion fat fatal father fatigue fault favorite feature february federal fee feed feel female fence festival fetch fever few fiber fiction field figure file film filter final find fine finger finish fire firm first fiscal fish fit fitness fix flag flame flash flat flavor flee flight flip float flock floor flower fluid flush fly foam focus fog foil fold follow food foot force forest forget fork fortune forum forward fossil foster found fox fragile frame frequent fresh friend fringe frog front frost frown frozen fruit fuel fun funny furnace fury future gadget gain galaxy gallery game gap garage garbage garden garlic garment gas gasp gate gather gauge gaze general genius genre gentle genuine gesture ghost giant gift giggle ginger giraffe girl give glad glance glare glass glide glimpse globe gloom glory glove glow glue goat goddess gold good goose gorilla gospel gossip govern gown grab grace grain grant grape grass gravity great green grid grief grit grocery group grow grunt guard guess guide guilt guitar gun gym habit hair half hammer hamster hand happy harbor hard harsh harvest hat have hawk hazard head health heart heavy hedgehog height hello helmet help hen hero hidden high hill hint hip hire history hobby hockey hold hole holiday hollow home honey hood hope horn horror horse hospital host hotel hour hover hub huge human humble humor hundred hungry hunt hurdle hurry hurt husband hybrid ice icon idea identify idle ignore ill illegal illness image imitate immense immune impact impose improve impulse inch include income increase index indicate indoor industry infant inflict inform inhale inherit initial inject injury inmate inner innocent input inquiry insane insect inside inspire install intact interest into invest invite involve iron island isolate issue item ivory jacket jaguar jar jazz jealous jeans jelly jewel job join joke journey joy judge juice jump jungle junior junk just kangaroo keen keep ketchup key kick kid kidney kind kingdom kiss kit kitchen kite kitten kiwi knee knife knock know lab label labor ladder lady lake lamp language laptop large later latin laugh laundry lava law lawn lawsuit layer lazy leader leaf learn leave lecture left leg legal legend leisure lemon lend length lens leopard lesson letter level liar liberty library license life lift light like limb limit link lion liquid list little live lizard load loan lobster local lock logic lonely long loop lottery loud lounge love loyal lucky luggage lumber lunar lunch luxury lyrics machine mad magic magnet maid mail main major make mammal man manage mandate mango mansion manual maple marble march margin marine market marriage mask mass master match material math matrix matter maximum maze meadow mean measure meat mechanic medal media melody melt member memory mention menu mercy merge merit merry mesh message metal method middle midnight milk million mimic mind minimum minor minute miracle mirror misery miss mistake mix mixed mixture mobile model modify mom moment monitor monkey monster month moon moral more morning mosquito mother motion motor mountain mouse move movie much muffin mule multiply muscle museum mushroom music must mutual myself mystery myth naive name napkin narrow nasty nation nature near neck need negative neglect neither nephew nerve nest net network neutral never news next nice night noble noise nominee noodle normal north nose notable note nothing notice novel now nuclear number nurse nut oak obey object oblige obscure observe obtain obvious occur ocean october odor off offer office often oil okay old olive olympic omit once one onion online only open opera opinion oppose option orange orbit orchard order ordinary organ orient original orphan ostrich other outdoor outer output outside oval oven over own owner oxygen oyster ozone pact paddle page pair palace palm panda panel panic panther paper parade parent park parrot party pass patch path patient patrol pattern pause pave payment peace peanut pear peasant pelican pen penalty pencil people pepper perfect permit person pet phone photo phrase physical piano picnic picture piece pig pigeon pill pilot pink pioneer pipe pistol pitch pizza place planet plastic plate play please pledge pluck plug plunge poem poet point polar pole police pond pony pool popular portion position possible post potato pottery poverty powder power practice praise predict prefer prepare present pretty prevent price pride primary print priority prison private prize problem process produce profit program project promote proof property prosper protect proud provide public pudding pull pulp pulse pumpkin punch pupil puppy purchase purity purpose purse push put puzzle pyramid quality quantum quarter question quick quit quiz quote rabbit raccoon race rack radar radio rail rain raise rally ramp ranch random range rapid rare rate rather raven raw razor ready real reason rebel rebuild recall receive recipe record recycle reduce reflect reform refuse region regret regular reject relax release relief rely remain remember remind remove render renew rent reopen repair repeat replace report require rescue resemble resist resource response result retire retreat return reunion reveal review reward rhythm rib ribbon rice rich ride ridge rifle right rigid ring riot ripple risk ritual rival river road roast robot robust rocket romance roof rookie room rose rotate rough round route royal rubber rude rug rule run runway rural sad saddle sadness safe sail salad salmon salon salt salute same sample sand satisfy satoshi sauce sausage save say scale scan scare scatter scene scheme school science scissors scorpion scout scrap screen script scrub sea search season seat second secret section security seed seek segment select sell seminar senior sense sentence series service session settle setup seven shadow shaft shallow share shed shell sheriff shield shift shine ship shiver shock shoe shoot shop short shoulder shove shrimp shrug shuffle shy sibling sick side siege sight sign silent silk silly silver similar simple since sing siren sister situate six size skate sketch ski skill skin skirt skull slab slam sleep slender slice slide slight slim slogan slot slow slush small smart smile smoke smooth snack snake snap sniff snow soap soccer social sock soda soft solar soldier solid solution solve someone song soon sorry sort soul sound soup source south space spare spatial spawn speak special speed spell spend sphere spice spider spike spin spirit split spoil sponsor spoon sport spot spray spread spring spy square squeeze squirrel stable stadium staff stage stairs stamp stand start state stay steak steel stem step stereo stick still sting stock stomach stone stool story stove strategy street strike strong struggle student stuff stumble style subject submit subway success such sudden suffer sugar suggest suit summer sun sunny sunset super supply supreme sure surface surge surprise surround survey suspect sustain swallow swamp swap swarm swear sweet swift swim swing switch sword symbol symptom syrup system table tackle tag tail talent talk tank tape target task taste tattoo taxi teach team tell ten tenant tennis tent term test text thank that theme then theory there they thing this thought three thrive throw thumb thunder ticket tide tiger tilt timber time tiny tip tired tissue title toast tobacco today toddler toe together toilet token tomato tomorrow tone tongue tonight tool tooth top topic topple torch tornado tortoise toss total tourist toward tower town toy track trade traffic tragic train transfer trap trash travel tray treat tree trend trial tribe trick trigger trim trip trophy trouble truck true truly trumpet trust truth try tube tuition tumble tuna tunnel turkey turn turtle twelve twenty twice twin twist two type typical ugly umbrella unable unaware uncle uncover under undo unfair unfold unhappy uniform unique unit universe unknown unlock until unusual unveil update upgrade uphold upon upper upset urban urge usage use used useful useless usual utility vacant vacuum vague valid valley valve van vanish vapor various vast vault vehicle velvet vendor venture venue verb verify version very vessel veteran viable vibrant vicious victory video view village vintage violin virtual virus visa visit visual vital vivid vocal voice void volcano volume vote voyage wage wagon wait walk wall walnut want warfare warm warrior wash wasp waste water wave way wealth weapon wear weasel weather web wedding weekend weird welcome west wet whale what wheat wheel when where whip whisper wide width wife wild will win window wine wing wink winner winter wire wisdom wise wish witness wolf woman wonder wood wool word work world worry worth wrap wreck wrestle wrist write wrong yard year yellow you young youth zebra zero zone zoo"
export const WORDS: readonly string[] = WORDS_RAW.split(' ')
