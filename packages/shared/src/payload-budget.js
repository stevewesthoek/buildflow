"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GPT_ACTION_DEFAULT_INSPECT_LIMIT = exports.GPT_ACTION_DEFAULT_FILE_BYTES = exports.GPT_ACTION_WARNING_BYTES = exports.GPT_ACTION_TARGET_BYTES = exports.GPT_ACTION_RESPONSE_BUDGET_BYTES = void 0;
exports.measureJsonPayload = measureJsonPayload;
exports.payloadBudgetReport = payloadBudgetReport;
exports.GPT_ACTION_RESPONSE_BUDGET_BYTES = 32000;
exports.GPT_ACTION_TARGET_BYTES = 8000;
exports.GPT_ACTION_WARNING_BYTES = 16000;
exports.GPT_ACTION_DEFAULT_FILE_BYTES = 6000;
exports.GPT_ACTION_DEFAULT_INSPECT_LIMIT = 10;
function measureJsonPayload(value) {
    return Buffer.byteLength(JSON.stringify(value !== null && value !== void 0 ? value : {}), 'utf8');
}
function payloadBudgetReport(value) {
    const bytes = measureJsonPayload(value);
    return {
        bytes,
        targetBytes: exports.GPT_ACTION_TARGET_BYTES,
        warningBytes: exports.GPT_ACTION_WARNING_BYTES,
        hardBudgetBytes: exports.GPT_ACTION_RESPONSE_BUDGET_BYTES,
        overTarget: bytes > exports.GPT_ACTION_TARGET_BYTES,
        overWarning: bytes > exports.GPT_ACTION_WARNING_BYTES,
        overBudget: bytes > exports.GPT_ACTION_RESPONSE_BUDGET_BYTES
    };
}
