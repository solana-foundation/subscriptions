import { CheckCircle2, XCircle } from 'lucide-react';
import { fmtDateTime } from '@/lib/utils';
import { ExplorerLink } from '@/components/cluster/cluster-ui';
import { getCollectionRecordTotalDisplayAmount, type CollectionRecord } from '@/lib/collection-history';

export function HistoryEntry({
    record,
    decimals,
    symbol,
}: {
    record: CollectionRecord;
    decimals: number;
    symbol: string;
}) {
    const isSuccess = record.status === 'success' || record.status === 'partial';
    const totalAmount = getCollectionRecordTotalDisplayAmount(record, 10 ** decimals);

    return (
        <div className="flex items-center gap-3 bg-sand-200 border border-sand-200 rounded-lg p-2 text-sm">
            {isSuccess ? (
                <CheckCircle2 className="h-4 w-4 text-foreground shrink-0" />
            ) : (
                <XCircle className="h-4 w-4 text-red-600 shrink-0" />
            )}
            <span className="text-slate-400 shrink-0">{fmtDateTime(record.timestamp)}</span>
            <span className="text-foreground">
                {totalAmount.toFixed(2)} {symbol} total from {record.subscribersCollected}/{record.subscribersTotal}{' '}
                subs
            </span>
            {isSuccess && record.signatures[0] && (
                <span className="ml-auto">
                    <ExplorerLink
                        transaction={record.signatures[0]}
                        label="tx"
                        className="text-foreground hover:text-sand-1100 text-xs"
                    />
                </span>
            )}
            {record.error && <span className="ml-auto text-red-600 truncate max-w-[200px]">{record.error}</span>}
        </div>
    );
}
