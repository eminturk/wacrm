import { eq } from 'drizzle-orm'

import { DEFAULT_CURRENCY } from '@/lib/currency'
import { getCurrentAccount } from '@/lib/auth/account'
import { accounts } from '@/lib/db/schema'
import {
  loadActivity,
  loadConversationsSeries,
  loadMetrics,
  loadPipelineDonut,
  loadResponseTime,
} from '@/lib/dashboard/queries'
import { DashboardClient } from './dashboard-client'

export default async function DashboardPage() {
  const ctx = await getCurrentAccount()

  const [
    metrics,
    series7,
    series30,
    series90,
    pipeline,
    responseTime,
    activity,
    accountRow,
  ] = await Promise.all([
    loadMetrics(ctx.db),
    loadConversationsSeries(ctx.db, 7),
    loadConversationsSeries(ctx.db, 30),
    loadConversationsSeries(ctx.db, 90),
    loadPipelineDonut(ctx.db),
    loadResponseTime(ctx.db),
    loadActivity(ctx.db, 50),
    ctx.db
      .select({ defaultCurrency: accounts.defaultCurrency })
      .from(accounts)
      .where(eq(accounts.id, ctx.accountId))
      .limit(1),
  ])

  return (
    <DashboardClient
      defaultCurrency={accountRow[0]?.defaultCurrency ?? DEFAULT_CURRENCY}
      metrics={metrics}
      series={{ 7: series7, 30: series30, 90: series90 }}
      pipeline={pipeline}
      responseTime={responseTime}
      activity={activity}
    />
  )
}
