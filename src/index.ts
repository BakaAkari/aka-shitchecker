import { Context, Schema, h } from 'koishi'

export const name = 'aka-shitchecker'

export interface Config {
  adminUsers: string[]
}

export const Config: Schema<Config> = Schema.object({
  adminUsers: Schema.array(Schema.string())
    .default([])
    .description('管理员用户ID列表（可使用惩戒指令）')
})

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
 * 格式化时长显示
 * @param ms 毫秒数
 */
function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000)
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  
  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    const remainingHours = hours % 24
    if (remainingHours === 0) {
      return `${days}天`
    }
    return `${days}天${remainingHours}小时`
  }
  if (hours > 0 && remainingMinutes > 0) {
    return `${hours}小时${remainingMinutes}分钟`
  }
  if (hours > 0) {
    return `${hours}小时`
  }
  return `${remainingMinutes}分钟`
}

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('aka-shitchecker')

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
        // 1. 尝试直接从 session.quote 获取
        if (session.quote.user && session.quote.user.id) {
          targetUserId = session.quote.user.id
          targetUserName = session.quote.user.name || targetUserId
        }
        
        // 2. 如果直接获取失败（某些适配器可能不返回引用消息的发送者信息），尝试通过 API 获取
        // 注意：不是所有适配器都支持 getMessage
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

      try {
        // 基础豁免检定（d20）
        const baseRoll = rollD20()
        logger.info('基础豁免检定', { 
          userId: session.userId, 
          targetUserId, 
          roll: baseRoll 
        })

        // ≥16：成功豁免
        if (baseRoll >= 16) {
          return `🎲 基础豁免检定结果：${baseRoll}\n✅ ${targetUserName} 成功豁免，无后续影响`
        }

        // ≤15：豁免失败，进入禁言时长判定
        // 进行次级检定（d20）
        const durationRoll = rollD20()
        logger.info('禁言时长判定', { 
          userId: session.userId, 
          targetUserId, 
          roll: durationRoll 
        })

        let muteDuration: number | null = null
        let resultMessage = `🎲 基础豁免检定结果：${baseRoll}\n❌ ${targetUserName} 豁免失败，进入禁言时长判定\n🎲 禁言时长判定结果：${durationRoll}\n`

        // 根据次级检定结果确定禁言时长（点数越小，禁言越长）
        if (durationRoll === 1) {
          // 大失败：24小时
          muteDuration = hoursToMilliseconds(24)
          resultMessage += `💀 大失败！禁言时长：24小时`
        } else if (durationRoll >= 2 && durationRoll <= 3) {
          // 12小时
          muteDuration = hoursToMilliseconds(12)
          resultMessage += `⏰ 禁言时长：12小时`
        } else if (durationRoll >= 4 && durationRoll <= 6) {
          // 6小时
          muteDuration = hoursToMilliseconds(6)
          resultMessage += `⏰ 禁言时长：6小时`
        } else if (durationRoll >= 7 && durationRoll <= 10) {
          // 2小时
          muteDuration = hoursToMilliseconds(2)
          resultMessage += `⏰ 禁言时长：2小时`
        } else if (durationRoll >= 11 && durationRoll <= 14) {
          // 30分钟
          muteDuration = 30 * 60 * 1000
          resultMessage += `⏰ 禁言时长：30分钟`
        } else if (durationRoll >= 15 && durationRoll <= 18) {
          // 10分钟
          muteDuration = 10 * 60 * 1000
          resultMessage += `⏰ 禁言时长：10分钟`
        } else if (durationRoll === 19) {
          // 5分钟
          muteDuration = 5 * 60 * 1000
          resultMessage += `⏰ 禁言时长：5分钟`
        } else if (durationRoll === 20) {
          // 大成功：豁免禁言
          resultMessage += `🎉 大成功！${targetUserName} 豁免禁言`
          return resultMessage
        }

        // 执行禁言操作
        if (muteDuration !== null) {
          try {
            // 尝试使用通用 API
            if (typeof session.bot.muteGuildMember === 'function') {
              await session.bot.muteGuildMember(
                session.guildId,
                targetUserId,
                muteDuration
              )
            } 
            // 如果通用 API 不存在，尝试使用 onebot 特定的 API
            else if (typeof (session.bot as any).$setGroupBan === 'function') {
              await (session.bot as any).$setGroupBan(
                session.guildId,
                targetUserId,
                muteDuration / 1000
              )
            } 
            // 如果都不存在，尝试使用内部 API
            else if (typeof (session.bot as any).internal?.setGroupBan === 'function') {
              await (session.bot as any).internal.setGroupBan(
                session.guildId,
                targetUserId,
                muteDuration / 1000
              )
            }
            else {
              throw new Error('当前适配器不支持禁言功能')
            }
            
            resultMessage += `\n✅ 已对 ${targetUserName} 执行禁言（${formatDuration(muteDuration)}）`
            
            logger.info('禁言执行成功', {
              operator: session.userId,
              target: targetUserId,
              duration: muteDuration,
              durationHours: muteDuration / 3600000
            })
          } catch (error: any) {
            logger.error('禁言执行失败', error)
            resultMessage += `\n❌ 禁言执行失败：${error.message || '未知错误'}`
          }
        }

        return resultMessage

      } catch (error: any) {
        logger.error('惩戒指令执行失败', error)
        return `执行失败：${error.message || '未知错误'}`
      }
    })
}

