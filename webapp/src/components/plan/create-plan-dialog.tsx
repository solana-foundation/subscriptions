import { useState, useMemo, useEffect } from 'react'
import { X, Plus, ChevronDown } from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useSubscriptionsMutations } from '@/hooks/use-subscriptions'
import { useUsdcMint } from '@/hooks/use-token-config'
import { cn, USDC_MULTIPLIER } from '@/lib/utils'
import { getBlockTimestamp } from '@/hooks/use-time-travel'
import { useClusterConfig } from '@/hooks/use-cluster-config'
import { PLAN_ICONS } from '@/lib/plan-constants'

const PLAN_TEMPLATES = [
  { label: 'Trading Bot', icon: 'BarChart3', planName: 'Trading Bot Pro', description: 'Automated crypto trading signals & execution', amount: '49.99', periodValue: '1', periodUnit: 'months' as const, website: 'https://tradingbot.example.com' },
  { label: 'Crypto NFAs', icon: 'Newspaper', planName: 'Crypto NFAs Weekly', description: 'Alpha calls & market analysis', amount: '19.99', periodValue: '1', periodUnit: 'weeks' as const, website: 'https://cryptonfas.example.com' },
  { label: 'Cloud Storage', icon: 'Cloud', planName: 'Cloud Storage 1TB', description: 'Decentralized encrypted cloud storage', amount: '4.99', periodValue: '1', periodUnit: 'months' as const, website: 'https://cloud.example.com' },
  { label: 'Video Streaming', icon: 'Video', planName: 'Video Streaming Plus', description: 'HD streaming with offline downloads', amount: '14.99', periodValue: '1', periodUnit: 'months' as const, website: 'https://streaming.example.com' },
]

interface CreatePlanDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CreatePlanDialog({ open, onOpenChange }: CreatePlanDialogProps) {
  const [planName, setPlanName] = useState('')
  const [description, setDescription] = useState('')
  const [selectedIcon, setSelectedIcon] = useState('')
  const [website, setWebsite] = useState('')
  const [amount, setAmount] = useState('')
  const [periodValue, setPeriodValue] = useState('')
  const [periodUnit, setPeriodUnit] = useState<'hours' | 'days' | 'weeks' | 'months'>('days')
  const [noEndDate, setNoEndDate] = useState(true)
  const [endDate, setEndDate] = useState('')
  const [endHour, setEndHour] = useState('12')
  const [destinations, setDestinations] = useState<string[]>([])
  const [pullers, setPullers] = useState<string[]>([])

  const { createPlan } = useSubscriptionsMutations()
  const usdcMint = useUsdcMint()
  const { url: rpcUrl } = useClusterConfig()
  const [blockTime, setBlockTime] = useState<number | undefined>()

  useEffect(() => {
    if (open) getBlockTimestamp(rpcUrl).then(setBlockTime).catch(() => {})
  }, [rpcUrl, open])

  const blockTs = blockTime ?? 0

  const UNIT_TO_HOURS = { hours: 1, days: 24, weeks: 168, months: 720 } as const
  const periodHours = Number(periodValue) * UNIT_TO_HOURS[periodUnit]

  const selectedIconEntry = PLAN_ICONS.find((i) => i.name === selectedIcon)
  const SelectedIconComponent = selectedIconEntry?.icon

  const metadataJson = useMemo(() => {
    const meta: Record<string, string> = { n: planName, d: description }
    if (selectedIcon) meta.i = selectedIcon
    if (website) meta.w = website
    return JSON.stringify(meta)
  }, [planName, description, selectedIcon, website])

  const metadataBytes = useMemo(
    () => new TextEncoder().encode(metadataJson).length,
    [metadataJson],
  )

  const resetForm = () => {
    setPlanName('')
    setDescription('')
    setSelectedIcon('')
    setWebsite('')
    setAmount('')
    setPeriodValue('')
    setPeriodUnit('days')
    setNoEndDate(true)
    setEndDate('')
    setEndHour('12')
    setDestinations([])
    setPullers([])
  }

  const handleOpenChange = (next: boolean) => {
    onOpenChange(next)
    if (!next) resetForm()
  }

  const addAddress = (list: string[], setList: (v: string[]) => void) => {
    if (list.length < 4) setList([...list, ''])
  }

  const removeAddress = (list: string[], setList: (v: string[]) => void, idx: number) => {
    setList(list.filter((_, i) => i !== idx))
  }

  const updateAddress = (list: string[], setList: (v: string[]) => void, idx: number, val: string) => {
    const next = [...list]
    next[idx] = val
    setList(next)
  }

  const applyTemplate = (t: typeof PLAN_TEMPLATES[number]) => {
    setPlanName(t.planName)
    setDescription(t.description)
    setSelectedIcon(t.icon)
    setWebsite(t.website)
    setAmount(t.amount)
    setPeriodValue(t.periodValue)
    setPeriodUnit(t.periodUnit)
  }

  const endTsComputed = endDate
    ? Math.floor(new Date(`${endDate}T${endHour.padStart(2, '0')}:00:00`).getTime() / 1000)
    : 0
  const minEndTs = blockTs + periodHours * 3600
  const isEndDateValid = endTsComputed === 0 || endTsComputed > minEndTs

  const isFormValid =
    planName.length > 0 &&
    description.length > 0 &&
    selectedIcon.length > 0 &&
    Number(amount) > 0 &&
    periodHours >= 1 &&
    metadataBytes <= 128 &&
    usdcMint !== null &&
    isEndDateValid

  const handleSubmit = async () => {
    if (!usdcMint) return

    const planId = crypto.getRandomValues(new BigUint64Array(1))[0]
    const amountInSmallestUnits = BigInt(Math.round(Number(amount) * USDC_MULTIPLIER))
    const endTsRaw = endDate
      ? Math.floor(new Date(`${endDate}T${endHour.padStart(2, '0')}:00:00`).getTime() / 1000)
      : 0
    const endTs = Number.isNaN(endTsRaw) ? 0 : endTsRaw

    const filteredDestinations = destinations.filter((d) => d.length > 0)
    const filteredPullers = pullers.filter((p) => p.length > 0)

    await createPlan.mutateAsync(
      {
        planId,
        mint: usdcMint,
        amount: amountInSmallestUnits,
        periodHours,
        endTs,
        destinations: filteredDestinations,
        pullers: filteredPullers,
        metadataUri: metadataJson,
      },
      { onSuccess: () => handleOpenChange(false) },
    )
  }

  const renderAddressList = (
    label: string,
    list: string[],
    setList: (v: string[]) => void,
    hint: string,
  ) => (
    <div className="grid gap-2">
      <Label>{label} <span className="text-muted-foreground font-normal">(optional, max 4)</span></Label>
      {list.map((addr, i) => (
        <div key={i} className="flex gap-2">
          <Input
            value={addr}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateAddress(list, setList, i, e.target.value)}
            placeholder="Solana address"
            className="font-mono text-sm flex-1"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => removeAddress(list, setList, i)}
            className="shrink-0 text-muted-foreground hover:text-destructive"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ))}
      {list.length < 4 && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => addAddress(list, setList)}
          className="w-fit gap-1"
        >
          <Plus className="h-3 w-3" /> Add
        </Button>
      )}
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[750px]">
        <DialogHeader>
          <DialogTitle>Create Subscription Plan</DialogTitle>
        </DialogHeader>

        <div className="mb-3">
          <p className="text-xs font-medium uppercase tracking-wider text-emerald-400 mb-2">Quick Templates</p>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {PLAN_TEMPLATES.map((t) => {
              const TIcon = PLAN_ICONS.find((i) => i.name === t.icon)?.icon
              return (
                <button
                  key={t.label}
                  type="button"
                  onClick={() => applyTemplate(t)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-full border border-border hover:border-emerald-500 hover:text-emerald-400 transition-colors whitespace-nowrap shrink-0"
                >
                  {TIcon && <TIcon className="h-3.5 w-3.5" />}
                  {t.label}
                </button>
              )
            })}
          </div>
        </div>

        <div className="max-h-[70vh] overflow-y-auto pr-1">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
            <div className="sm:col-span-2">
              <p className="text-xs font-medium uppercase tracking-wider text-emerald-400">Metadata</p>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="plan-name">Plan Name</Label>
              <Input
                id="plan-name"
                value={planName}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPlanName(e.target.value)}
                placeholder="My Subscription"
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="plan-desc">Description</Label>
              <Input
                id="plan-desc"
                value={description}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDescription(e.target.value)}
                placeholder="Access to premium features"
              />
            </div>

            <div className="grid gap-2">
              <Label>Icon</Label>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" className="w-full justify-between">
                    {SelectedIconComponent ? (
                      <span className="flex items-center gap-2">
                        <SelectedIconComponent className="h-4 w-4 text-emerald-400" />
                        {selectedIconEntry.label}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Select an icon</span>
                    )}
                    <ChevronDown className="h-4 w-4 opacity-50" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="max-h-60 overflow-y-auto w-56">
                  {PLAN_ICONS.map(({ name, label, icon: Icon }) => (
                    <DropdownMenuItem
                      key={name}
                      onClick={() => setSelectedIcon(name)}
                      className={cn(
                        'flex items-center gap-2 cursor-pointer',
                        selectedIcon === name && 'text-emerald-400',
                      )}
                    >
                      <Icon className="h-4 w-4" />
                      {label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="plan-website">Website URL <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Input
                id="plan-website"
                value={website}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setWebsite(e.target.value)}
                placeholder="https://example.com"
              />
            </div>

            <div className="sm:col-span-2">
              <p className={cn(
                'text-xs text-right',
                metadataBytes > 128 ? 'text-destructive' : 'text-muted-foreground',
              )}>
                {metadataBytes}/128 bytes
              </p>
            </div>

            <div className="sm:col-span-2 h-px bg-border" />

            <div className="sm:col-span-2">
              <p className="text-xs font-medium uppercase tracking-wider text-emerald-400">Plan Parameters</p>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="plan-amount">Amount per Period</Label>
              <div className="flex gap-2">
                <Input
                  id="plan-amount"
                  type="number"
                  min="0"
                  step="0.01"
                  value={amount}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAmount(e.target.value)}
                  placeholder="9.99"
                  className="flex-1"
                />
                <span className="h-10 flex items-center rounded-md border border-input bg-background px-3 text-sm text-muted-foreground">USDC</span>
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="plan-period">Billing Period</Label>
              <div className="flex gap-2">
                <Input
                  id="plan-period"
                  type="number"
                  min="1"
                  value={periodValue}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPeriodValue(e.target.value)}
                  placeholder="30"
                  className="flex-1"
                />
                <select
                  value={periodUnit}
                  onChange={(e) => setPeriodUnit(e.target.value as typeof periodUnit)}
                  className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                >
                  <option value="hours">Hours</option>
                  <option value="days">Days</option>
                  <option value="weeks">Weeks</option>
                  <option value="months">Months</option>
                </select>
              </div>
            </div>

            <div className="sm:col-span-2 grid gap-2">
              <div className="flex items-center justify-between">
                <Label>End Date/Time</Label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <span className="text-xs text-muted-foreground">No end date</span>
                  <input
                    type="checkbox"
                    checked={noEndDate}
                    onChange={(e) => { setNoEndDate(e.target.checked); if (e.target.checked) setEndDate('') }}
                    className="h-4 w-4 rounded border-gray-600 bg-gray-800 text-emerald-500 focus:ring-emerald-500/30"
                  />
                </label>
              </div>
              {noEndDate ? (
                <div className="flex items-center gap-2 rounded-md border border-gray-700/50 bg-gray-900/50 px-3 py-2.5">
                  <span className="text-sm text-gray-400">This plan will not have an end date</span>
                </div>
              ) : (
                <>
                  <div className="flex gap-2">
                    <Input
                      type="date"
                      value={endDate}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEndDate(e.target.value)}
                      min={new Date(minEndTs * 1000).toLocaleDateString('en-CA')}
                      className="flex-1"
                    />
                    <select
                      value={endHour}
                      onChange={(e) => setEndHour(e.target.value)}
                      className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                    >
                      {Array.from({ length: 24 }, (_, i) => (
                        <option key={i} value={i.toString()}>
                          {i.toString().padStart(2, '0')}:00
                        </option>
                      ))}
                    </select>
                  </div>
                  {endDate && !isEndDateValid && (
                    <p className="text-xs text-destructive">
                      End date must be at least one billing period ({periodHours}h) from now
                    </p>
                  )}
                </>
              )}
            </div>

            <div className="sm:col-span-2">
              {renderAddressList('Destinations', destinations, setDestinations, 'Leave empty to allow any destination at transfer time.')}
            </div>
            <div className="sm:col-span-2">
              {renderAddressList('Pullers', pullers, setPullers, 'Leave empty to restrict pulling to plan owner only (recommended).')}
            </div>
          </div>
        </div>

        <DialogFooter className="mt-4">
          <Button
            onClick={handleSubmit}
            disabled={createPlan.isPending || !isFormValid}
            className="w-full bg-emerald-600 hover:bg-emerald-500 text-white"
          >
            {createPlan.isPending ? 'Creating...' : 'Create Plan'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
