import { Upload, XCircle } from 'lucide-react';
import { useId, useState, type ChangeEvent } from 'react';
import { Button } from '@/components/ui/button';
import { parseProgramKeypairJson, type ProgramKeypairImport } from '@/lib/program-keypair';
import { truncateAddress } from '@/lib/format';

interface ProgramKeypairPickerProps {
    disabled?: boolean;
    onChange: (keypair: ProgramKeypairImport | null) => void;
    value: ProgramKeypairImport | null;
}

export function ProgramKeypairPicker({ disabled, onChange, value }: ProgramKeypairPickerProps) {
    const inputId = useId();
    const [error, setError] = useState('');

    const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        if (!file) return;
        setError('');
        try {
            onChange(await parseProgramKeypairJson(await file.text(), file.name));
        } catch (e) {
            onChange(null);
            setError(e instanceof Error ? e.message : String(e));
        }
    };

    return (
        <div className="rounded-lg border border-sand-300 bg-sand-100 p-3 space-y-3">
            <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                    <p className="text-xs font-medium text-sand-1400">Program keypair</p>
                    {value ? (
                        <p className="text-[10px] text-sand-1000 truncate">
                            {value.fileName} · {truncateAddress(value.programAddress)}
                        </p>
                    ) : (
                        <p className="text-[10px] text-sand-1000">Required for initial deploy</p>
                    )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    {value && (
                        <Button
                            onClick={() => {
                                onChange(null);
                                setError('');
                            }}
                            variant="ghost"
                            size="sm"
                            aria-label="Clear program keypair"
                            className="h-8 px-2 text-sand-1000 hover:text-foreground"
                            disabled={disabled}
                        >
                            <XCircle className="h-4 w-4" />
                        </Button>
                    )}
                    <label htmlFor={inputId}>
                        <span className="inline-flex h-8 cursor-pointer items-center justify-center gap-2 rounded-md border border-sand-300 bg-card px-3 text-xs font-medium text-foreground hover:bg-sand-100">
                            <Upload className="h-3.5 w-3.5" />
                            Select JSON
                        </span>
                    </label>
                </div>
            </div>
            <input
                id={inputId}
                type="file"
                accept="application/json,.json"
                className="sr-only"
                onChange={handleFileChange}
                disabled={disabled}
            />
            {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
    );
}
