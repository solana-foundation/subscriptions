import { useState, useEffect } from 'react'
import { Coins, RefreshCw, Plus, ArrowLeft } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useSubscriptionsMutations } from '@/hooks/use-subscriptions-mutations'
import { DELEGATION_KINDS, type DelegationKindId } from '@/lib/delegation-kinds'
import { cn, USDC_MULTIPLIER, SECONDS_PER_DAY } from '@/lib/utils'
import { getBlockTimestamp } from '@/hooks/use-time-travel'
import { useClusterConfig } from '@/hooks/use-cluster-config'

interface CreateDelegationDialogProps {
  tokenMint: string
  disabled?: boolean
}

interface KindCardProps {
  kind: DelegationKindId
  selected: boolean
  onClick: () => void
}

function KindCard({ kind, selected, onClick }: KindCardProps) {
  const config = DELEGATION_KINDS[kind]
  const Icon = kind === 'fixed' ? Coins : RefreshCw

  return (
    <button
      onClick={onClick}
      className={cn(
        'flex flex-col items-center p-4 rounded-lg border-2 transition-all duration-200',
        'hover:border-emerald-500/50',
        selected
          ? 'border-emerald-500 bg-emerald-500/10'
          : 'border-border bg-card hover:bg-accent/50'
      )}
    >
      <Icon className={cn('h-8 w-8 mb-2', selected ? 'text-emerald-400' : 'text-muted-foreground')} />
      <span className={cn('font-medium', selected ? 'text-emerald-400' : 'text-foreground')}>
        {config.label}
      </span>
      <span className="text-xs text-muted-foreground text-center mt-1">{config.description}</span>
    </button>
  )
}

export function CreateDelegationDialog({ tokenMint, disabled }: CreateDelegationDialogProps) {
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<'kind' | 'form'>('kind')
  const [selectedKind, setSelectedKind] = useState<DelegationKindId>('fixed')

  // Form states
  const [delegatee, setDelegatee] = useState('')
  const [amount, setAmount] = useState('')
  const [noExpiry, setNoExpiry] = useState(false)
  const [expiryDate, setExpiryDate] = useState('')
  const [expiryHour, setExpiryHour] = useState('12')
  const [periodDays, setPeriodDays] = useState('')

  const { createFixedDelegation, createRecurringDelegation } = useSubscriptionsMutations()
  const { url: rpcUrl } = useClusterConfig()
  const [blockTime, setBlockTime] = useState<number | undefined>()

  useEffect(() => {
    if (open) {
      getBlockTimestamp(rpcUrl).then(setBlockTime).catch(() => {})
    }
  }, [rpcUrl, open])

  const blockDate = blockTime ? new Date(blockTime * 1000) : new Date()

  const resetForm = () => {
    setDelegatee('')
    setAmount('')
    setNoExpiry(false)
    setExpiryDate('')
    setExpiryHour('12')
    setPeriodDays('')
    setStep('kind')
    setSelectedKind('fixed')
  }

  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen)
    if (!newOpen) {
      resetForm()
    }
  }

  const handleKindSelect = (kind: DelegationKindId) => {
    setSelectedKind(kind)
  }

  const handleContinue = () => {
    setStep('form')
  }

  const handleBack = () => {
    setStep('kind')
  }

  const generateNonce = (): bigint => {
    return crypto.getRandomValues(new BigUint64Array(1))[0]
  }

  const handleSubmit = async () => {
    const nonce = generateNonce()
    let expiryTimestamp = 0
    if (!noExpiry) {
      const expiryDateTime = new Date(`${expiryDate}T${expiryHour.padStart(2, '0')}:00:00`)
      expiryTimestamp = Math.floor(expiryDateTime.getTime() / 1000)
      if (Number.isNaN(expiryTimestamp) || expiryTimestamp <= 0) return
    }
    const amountInSmallestUnits = BigInt(Math.round(Number(amount) * USDC_MULTIPLIER))

    if (selectedKind === 'fixed') {
      await createFixedDelegation.mutateAsync(
        {
          tokenMint,
          delegatee,
          nonce,
          amount: amountInSmallestUnits,
          expiryTs: expiryTimestamp,
        },
        {
          onSuccess: () => {
            handleOpenChange(false)
          },
        }
      )
    } else {
      const periodSeconds = Number(periodDays) * SECONDS_PER_DAY

      await createRecurringDelegation.mutateAsync(
        {
          tokenMint,
          delegatee,
          nonce,
          amountPerPeriod: amountInSmallestUnits,
          periodLengthS: periodSeconds,
          expiryTs: expiryTimestamp,
        },
        {
          onSuccess: () => {
            handleOpenChange(false)
          },
        }
      )
    }
  }

  const isPending = createFixedDelegation.isPending || createRecurringDelegation.isPending

  const isExpiryValid = () => {
    if (noExpiry) return true
    if (!expiryDate) return false
    const expiryDateTime = new Date(`${expiryDate}T${expiryHour.padStart(2, '0')}:00:00`)
    return expiryDateTime > blockDate
  }

  const isFormValid =
    delegatee.length >= 32 &&
    delegatee.length <= 44 &&
    amount.length > 0 &&
    Number(amount) > 0 &&
    (noExpiry || expiryDate.length > 0) &&
    isExpiryValid() &&
    (selectedKind === 'fixed' || (periodDays.length > 0 && Number(periodDays) > 0))

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button disabled={disabled} className="gap-2 rounded-full px-6 h-11 bg-emerald-600 hover:bg-emerald-500 text-white shadow-[0_0_20px_rgba(16,185,129,0.5)] transition-all hover:shadow-[0_0_25px_rgba(16,185,129,0.7)] border border-emerald-500/50">
          <Plus className="h-5 w-5" />
          Create Delegation
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>
            {step === 'kind' ? 'Create New Delegation' : `New ${DELEGATION_KINDS[selectedKind].label} Delegation`}
          </DialogTitle>
        </DialogHeader>

        {step === 'kind' ? (
          <>
            <p className="text-xs font-medium uppercase tracking-wider text-emerald-400 mb-4">
              Choose Delegation Type
            </p>
            <div className="grid grid-cols-2 gap-4">
              <KindCard
                kind="fixed"
                selected={selectedKind === 'fixed'}
                onClick={() => handleKindSelect('fixed')}
              />
              <KindCard
                kind="recurring"
                selected={selectedKind === 'recurring'}
                onClick={() => handleKindSelect('recurring')}
              />
            </div>
            <DialogFooter className="mt-6">
              <Button onClick={handleContinue} className="w-full bg-emerald-600 hover:bg-emerald-500 text-white">
                Continue
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="grid gap-4 py-2">
              <div className="grid gap-2">
                <Label htmlFor="delegatee">Delegatee Address</Label>
                <Input
                  id="delegatee"
                  value={delegatee}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDelegatee(e.target.value)}
                  placeholder="Enter Solana wallet address"
                  className="font-mono text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  The wallet address that can withdraw tokens
                </p>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="amount">
                  {selectedKind === 'fixed' ? 'Total Amount (USDC)' : 'Amount per Period (USDC)'}
                </Label>
                <Input
                  id="amount"
                  type="number"
                  min="0"
                  step="0.01"
                  value={amount}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAmount(e.target.value)}
                  placeholder="100.00"
                />
              </div>

              {selectedKind === 'recurring' && (
                <div className="grid gap-2">
                  <Label htmlFor="period">Period Length (days)</Label>
                  <Input
                    id="period"
                    type="number"
                    min="1"
                    value={periodDays}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPeriodDays(e.target.value)}
                    placeholder="7"
                  />
                  <p className="text-xs text-muted-foreground">
                    How often the delegatee can withdraw the specified amount
                  </p>
                </div>
              )}

              <div className="grid gap-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="expiry-date">Expiry</Label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <span className="text-xs text-muted-foreground">No expiry</span>
                    <input
                      type="checkbox"
                      checked={noExpiry}
                      onChange={(e) => { setNoExpiry(e.target.checked); if (e.target.checked) setExpiryDate('') }}
                      className="h-4 w-4 rounded border-gray-600 bg-gray-800 text-emerald-500 focus:ring-emerald-500/30"
                    />
                  </label>
                </div>
                {noExpiry ? (
                  <div className="flex items-center gap-2 rounded-md border border-gray-700/50 bg-gray-900/50 px-3 py-2.5">
                    <span className="text-sm text-gray-400">This delegation will not have an expiration time</span>
                  </div>
                ) : (
                  <>
                    <div className="flex gap-2">
                      <Input
                        id="expiry-date"
                        type="date"
                        value={expiryDate}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setExpiryDate(e.target.value)}
                        min={blockDate.toLocaleDateString('en-CA')}
                        className="flex-1"
                      />
                      <select
                        id="expiry-hour"
                        value={expiryHour}
                        onChange={(e) => setExpiryHour(e.target.value)}
                        className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                      >
                        {Array.from({ length: 24 }, (_, i) => (
                          <option key={i} value={i.toString()}>
                            {i.toString().padStart(2, '0')}:00
                          </option>
                        ))}
                      </select>
                    </div>
                    {expiryDate && !isExpiryValid() && (
                      <p className="text-xs text-destructive">
                        Expiry date must be in the future
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      The delegation will expire and become invalid after this date
                    </p>
                  </>
                )}
              </div>
            </div>

            <DialogFooter className="flex gap-2 mt-4">
              <Button variant="outline" onClick={handleBack} disabled={isPending}>
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={isPending || !isFormValid}
                className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white"
              >
                {isPending ? 'Creating...' : 'Create Delegation'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
