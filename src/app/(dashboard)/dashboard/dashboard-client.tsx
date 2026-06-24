"use client"

import { useCallback, useState } from 'react'
import { formatCurrency } from '@/lib/currency'
import {
  MessageSquare,
  UserPlus,
  DollarSign,
  Send,
} from 'lucide-react'
import type {
  ActivityItem,
  ConversationsSeriesPoint,
  MetricsBundle,
  PipelineDonutData,
  ResponseTimeSummary,
} from '@/lib/dashboard/types'

import { MetricCard } from '@/components/dashboard/metric-card'
import { QuickActions } from '@/components/dashboard/quick-actions'
import { ConversationsChart } from '@/components/dashboard/conversations-chart'
import { PipelineDonut } from '@/components/dashboard/pipeline-donut'
import { ResponseTimeChart } from '@/components/dashboard/response-time-chart'
import { ActivityFeed } from '@/components/dashboard/activity-feed'

type RangeDays = 7 | 30 | 90

interface DashboardClientProps {
  defaultCurrency: string
  metrics: MetricsBundle
  series: Record<RangeDays, ConversationsSeriesPoint[]>
  pipeline: PipelineDonutData
  responseTime: ResponseTimeSummary
  activity: ActivityItem[]
}

export function DashboardClient({
  defaultCurrency,
  metrics,
  series,
  pipeline,
  responseTime,
  activity,
}: DashboardClientProps) {
  const [range, setRange] = useState<RangeDays>(30)

  const handleRangeChange = useCallback((r: RangeDays) => {
    setRange(r)
  }, [])

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">Dashboard</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Live analytics across conversations, contacts, deals, broadcasts, and automations.
        </p>
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          title="Active Conversations"
          value={metrics.activeConversations.current.toLocaleString()}
          icon={MessageSquare}
          delta={{
            sign: metrics.activeConversations.previous,
            label: deltaLabel(metrics.activeConversations.previous, 'new today vs yesterday'),
          }}
        />
        <MetricCard
          title="New Contacts Today"
          value={metrics.newContactsToday.current.toLocaleString()}
          icon={UserPlus}
          delta={{
            sign:
              metrics.newContactsToday.current - metrics.newContactsToday.previous,
            label: deltaLabel(
              metrics.newContactsToday.current - metrics.newContactsToday.previous,
              'vs yesterday',
            ),
          }}
        />
        <MetricCard
          title="Open Deals Value"
          value={formatCurrency(metrics.openDealsValue, defaultCurrency)}
          icon={DollarSign}
          subtitle={`${metrics.openDealsCount} open deal${metrics.openDealsCount === 1 ? '' : 's'}`}
        />
        <MetricCard
          title="Messages Sent Today"
          value={metrics.messagesSentToday.current.toLocaleString()}
          icon={Send}
          delta={{
            sign:
              metrics.messagesSentToday.current - metrics.messagesSentToday.previous,
            label: deltaLabel(
              metrics.messagesSentToday.current - metrics.messagesSentToday.previous,
              'vs yesterday',
            ),
          }}
        />
      </div>

      {/* Quick actions */}
      <QuickActions />

      {/* Charts row */}
      {/* items-stretch (the grid default) stretches the two columns to
          match the tallest sibling; adding h-full on each wrapper and
          on the inner panels makes both cards actually fill that
          stretched height so their rounded borders line up. Without
          this, the pipeline card rendered at its natural (shorter)
          height while the line chart drove the row height. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="h-full lg:col-span-3">
          <ConversationsChart
            series={series}
            loading={false}
            range={range}
            onRangeChange={handleRangeChange}
          />
        </div>
        <div className="h-full lg:col-span-2">
          <PipelineDonut
            data={pipeline}
            loading={false}
            currency={defaultCurrency}
          />
        </div>
      </div>

      {/* Response time */}
      <ResponseTimeChart data={responseTime} loading={false} />

      {/* Activity feed */}
      <ActivityFeed items={activity} loading={false} />
    </div>
  )
}

// ------------------------------------------------------------

function deltaLabel(delta: number, suffix: string): string {
  if (delta === 0) return `No change ${suffix}`
  const sign = delta > 0 ? '+' : ''
  return `${sign}${delta.toLocaleString()} ${suffix}`
}
