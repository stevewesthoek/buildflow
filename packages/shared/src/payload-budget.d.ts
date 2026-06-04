export declare const GPT_ACTION_RESPONSE_BUDGET_BYTES = 32000;
export declare const GPT_ACTION_TARGET_BYTES = 8000;
export declare const GPT_ACTION_WARNING_BYTES = 16000;
export declare const GPT_ACTION_DEFAULT_FILE_BYTES = 4000;
export declare const GPT_ACTION_DEFAULT_INSPECT_LIMIT = 5;
export type PayloadBudgetReport = {
    bytes: number;
    targetBytes: number;
    warningBytes: number;
    hardBudgetBytes: number;
    overTarget: boolean;
    overWarning: boolean;
    overBudget: boolean;
};
export declare function measureJsonPayload(value: unknown): number;
export declare function payloadBudgetReport(value: unknown): PayloadBudgetReport;
