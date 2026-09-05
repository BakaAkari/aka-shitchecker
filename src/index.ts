import { Context, Schema, h } from 'koishi'

export const name = 'aka-shitchecker'

export interface DurationRule {
  /** 点数范围起点（包含） */
  start: number
  /** 点数范围终点（包含） */
  end: number
  /** 禁言小时数，0 表示豁免禁言 */
  hours: number
  /** 该结果的附加提示文本，可留空 */
  label: string
}

export interface Config {
  adminUsers: string[]
  /** 引用消息触发惩戒时，是否直接撤回被引用的消息 */
  recallQuotedMessage: boolean
  /** 是否启用两段掷骰；关闭后跳过基础豁免，直接进行禁言时长判定 */
  enableTwoStageRoll: boolean
  /** 基础豁免成功范围起点（包含） */
  exemptionRangeStart: number
  /** 基础豁免成功范围终点（包含） */
  exemptionRangeEnd: number
  /** 禁言时长判定规则 */
  durationRules: DurationRule[]
}

export const Config: Schema<Config> = Schema.object({
  adminUsers: Schema.array(Schema.string())
    .default([])
    .description('管理员用户ID列表（可使用惩戒指令）'),
  recallQuotedMessage: Schema.boolean()
    .default(true)
    .description('引用消息触发惩戒时，是否直接撤回被引用的消息'),
  enableTwoStageRoll: Schema.boolean()
    .default(true)
    .description('是否启用两段掷骰；关闭后跳过基础豁免，直接进行禁言时长判定'),
  exemptionRangeStart: Schema.number()
    .min(1)
    .max(20)
    .default(20)
    .description('基础豁免成功范围起点（包含）'),
  exemptionRangeEnd: Schema.number()
    .min(1)
    .max(20)
    .default(20)
    .description('基础豁免成功范围终点（包含）'),
  durationRules: Schema.array(Schema.object({
    start: Schema.number().min(1).max(20).required(),
    end: Schema.number().min(1).max(20).required(),
    hours: Schema.number().min(0).required(),
    label: Schema.string().default(''),
  }))
    .default([])
    .description('禁言时长判定规则；范围必须完整覆盖 1～20，且不能相互重叠'),
})

/** 默认规则：与截图配置一致（1=大失败168h，20=大成功豁免） */
export const DEFAULT_DURATION_RULES: DurationRule[] = [
  { start: 1, end: 1, hours: 168, label: '大失败！' },
  { start: 2, end: 6, hours: 12, label: '' },
  { start: 7, end: 14, hours: 24, label: '' },
  { start: 15, end: 17, hours: 72, label: '' },
  { start: 18, end: 19, hours: 120, label: '' },
  { start: 20, end: 20, hours: 0, label: '大成功！' },
]

/**
 * 生成 1-20 的随机数（d20）
 * 点数越小，禁言时间越长
 */
function rollD20(): number {
  return Math.floor(Math.random() * 20) + 1
}

/**
 * 检查用户是否为管理员
 */
function isAdmin(userId: string, adminUsers: string[]): boolean {
  return adminUsers.includes(userId)
}

/**
 * 将小时转换为毫秒
 */
function hoursToMilliseconds(hours: number): number {
  return hours * 60 * 60 * 1000
}

/**
 * 格式化时长显示（按小时）
 */
function formatDuration(hours: number): string {
  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    const remainingHours = hours % 24
    if (remainingHours === 0) {
      return `${days}天`
    }
    return `${days}天${remainingHours}小时`
  }
  if (hours >= 1) {
    const remainingMinutes = Math.round((hours % 1) * 60)
    if (remainingMinutes > 0) {
      return `${Math.floor(hours)}小时${remainingMinutes}分钟`
    }
    return `${Math.floor(hours)}小时`
  }
  return `${Math.round(hours * 60)}分钟`
}

/**
 * 校验 durationRules 是否完整覆盖 1-20 且无重叠
 */
function validateDurationRules(rules: DurationRule[]): string | null {
  if (!rules.length) {
    return '未配置禁言时长规则'
  }
  // 排序后检查覆盖与重叠
  const sorted = [...rules].sort((a, b) => a.start - b.start)
  let cursor = 1
  for (const rule of sorted) {
    if (rule.start > cursor) {
      return `点数范围 ${cursor} 未被任何规则覆盖`
    }
    if (rule.end < rule.start) {
      return `规则 ${rule.start}-${rule.end} 的区间起点大于终点`
    }
    if (rule.start < cursor) {
      return `规则 ${rule.start}-${rule.end} 与上一个规则重叠`
    }
    cursor = Math.max(cursor, rule.end + 1)
  }
  if (cursor <= 20) {
    return `点数范围 ${cursor}-20 未被任何规则覆盖`
  }
  return null
}

/**
 * 根据点数匹配禁言规则
 * @returns 命中规则；未命中返回 null
 */
function matchDurationRule(rules: DurationRule[], roll: number): DurationRule | null {
  return rules.find((r) => roll >= r.start && roll <= r.end) ?? null
}

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('aka-shitchecker')

  // 若未配置规则，回退到默认可视化规则，保证开箱即用
  const rules = config.durationRules.length ? config.durationRules : DEFAULT_DURATION_RULES

  // 注册惩戒指令
  ctx.command('惩戒 [target:text]', '对群成员进行随机数鉴定并执行禁言')
    .action(async ({ session }, target) => {
      // 检查是否在群组中
      if (!session.guildId) {
        return '此指令只能在群组中使用'
      }

      // 检查权限（仅管理员可用）
      if (!isAdmin(session.userId, config.adminUsers)) {
        return '权限不足，仅管理员可使用此指令'
      }

      // 解析 @ 用户
      let targetUserId: string | null = null
      let targetUserName: string = '未知用户'
      let quoted = false
      let quotedMessageId: string | null = null

      if (target) {
        const elements = h.parse(target)
        const atElements = h.select(elements, 'at')
        if (atElements.length > 0) {
          targetUserId = atElements[0].attrs.id
          targetUserName = atElements[0].attrs.name || targetUserId
        }
      }

      // 如果没有找到 @ 用户，尝试从引用消息中获取
      if (!targetUserId && session.quote) {
        quoted = true
        quotedMessageId = session.quote.id ?? null
        // 1. 尝试直接从 session.quote 获取
        if (session.quote.user && session.quote.user.id) {
          targetUserId = session.quote.user.id
          targetUserName = session.quote.user.name || targetUserId
        }

        // 2. 如果直接获取失败（某些适配器可能不返回引用消息的发送者信息），尝试通过 API 获取
        if (!targetUserId && session.quote.id) {
          try {
            logger.debug('尝试通过 API 获取引用消息详情', session.quote.id)
            const quoteMsg = await session.bot.getMessage(session.channelId, session.quote.id)
            if (quoteMsg && quoteMsg.user && quoteMsg.user.id) {
              targetUserId = quoteMsg.user.id
              targetUserName = quoteMsg.user.name || targetUserId
            }
          } catch (error) {
            logger.warn('获取引用消息详情失败', error)
          }
        }
      }

      // 如果还是没有找到，返回错误
      if (!targetUserId) {
        return '请 @ 要惩戒的群成员，或引用其消息'
      }

      // 不能惩戒自己
      if (targetUserId === session.userId) {
        return '不能对自己使用惩戒指令'
      }

      // 不能惩戒机器人
      if (targetUserId === session.bot.userId) {
        return '不能对机器人使用惩戒指令'
      }

      // 撤回被引用的消息（如开启且由引用触发）
      if (config.recallQuotedMessage && quoted && quotedMessageId) {
        try {
          await session.bot.deleteMessage(session.channelId, quotedMessageId)
          logger.info('已撤回被引用的消息', {
            operator: session.userId,
            target: targetUserId,
            messageId: quotedMessageId,
          })
        } catch (error) {
          logger.warn('撤回被引用消息失败', error)
        }
      }

      try {
        const resultMessages: string[] = []

        // 基础豁免检定（两段掷骰开启时）
        if (config.enableTwoStageRoll) {
          const baseRoll = rollD20()
          logger.info('基础豁免检定', {
            userId: session.userId,
            targetUserId,
            roll: baseRoll,
          })
          resultMessages.push(`🎲 基础豁免检定结果：${baseRoll}`)

          if (baseRoll >= config.exemptionRangeStart && baseRoll <= config.exemptionRangeEnd) {
            resultMessages.push(`✅ ${targetUserName} 成功豁免，无后续影响`)
            return resultMessages.join('\n')
          }

          resultMessages.push(`❌ ${targetUserName} 豁免失败，进入禁言时长判定`)
        }

        // 禁言时长判定（d20）
        const durationRoll = rollD20()
        logger.info('禁言时长判定', {
          userId: session.userId,
          targetUserId,
          roll: durationRoll,
        })
        resultMessages.push(`🎲 禁言时长判定结果：${durationRoll}`)

        // 校验规则完整性
        const validationError = validateDurationRules(rules)
        if (validationError) {
          logger.warn('禁言规则配置无效', { error: validationError })
          return `⚠️ 禁言规则配置无效：${validationError}`
        }

        const rule = matchDurationRule(rules, durationRoll)
        if (!rule) {
          logger.warn('点数未命中任何规则', { roll: durationRoll })
          return `⚠️ 点数 ${durationRoll} 未命中任何禁言规则，请检查配置`
        }

        const muteDurationMs = hoursToMilliseconds(rule.hours)
        const labelSuffix = rule.label ? ` ${rule.label}` : ''

        // 豁免（hours=0）
        if (rule.hours === 0) {
          resultMessages.push(`🎉${labelSuffix} ${targetUserName} 豁免禁言`)
          return resultMessages.join('\n')
        }

        resultMessages.push(`⏰ 禁言时长：${formatDuration(rule.hours)}${labelSuffix}`)

        // 执行禁言操作
        if (muteDurationMs > 0) {
          try {
            // 尝试使用通用 API
            if (typeof session.bot.muteGuildMember === 'function') {
              await session.bot.muteGuildMember(session.guildId, targetUserId, muteDurationMs)
            }
            // 如果通用 API 不存在，尝试使用 onebot 特定的 API
            else if (typeof (session.bot as any).$setGroupBan === 'function') {
              await (session.bot as any).$setGroupBan(session.guildId, targetUserId, muteDurationMs / 1000)
            }
            // 如果都不存在，尝试使用内部 API
            else if (typeof (session.bot as any).internal?.setGroupBan === 'function') {
              await (session.bot as any).internal.setGroupBan(session.guildId, targetUserId, muteDurationMs / 1000)
            }
            else {
              throw new Error('当前适配器不支持禁言功能')
            }

            resultMessages.push(`✅ 已对 ${targetUserName} 执行禁言（${formatDuration(rule.hours)}）`)

            logger.info('禁言执行成功', {
              operator: session.userId,
              target: targetUserId,
              duration: muteDurationMs,
              durationHours: rule.hours,
            })
          } catch (error: any) {
            logger.error('禁言执行失败', error)
            resultMessages.push(`❌ 禁言执行失败：${error.message || '未知错误'}`)
          }
        }

        return resultMessages.join('\n')
      } catch (error: any) {
        logger.error('惩戒指令执行失败', error)
        return `执行失败：${error.message || '未知错误'}`
      }
    })
}