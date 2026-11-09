use core::fmt;

/// Stable error codes from blueprint §6.8. The code string is what clients key on;
/// the message is for humans and may carry debugging detail.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ContractError {
    PolicyNotFound,
    NotActive,
    OutsideWindow,
    UnknownAgent,
    Duplicate,
    BadSignatureJson,
    GatewaySignature,
    UnsupportedAlgo,
    WrongModel,
    /// Carries the text the contract expected, so the client can diff it (§6.8).
    TextMismatch(String),
    UnknownSigner,
    Unparseable,
    TaskMismatch,
    ReceiptAlreadyPosted,
    PoolExhausted,
    WithdrawLocked,
    Unauthorized,
    Paused,
    // Codes below are not in the §6.8 table; the purchase path needs them and the
    // blueprint records them alongside the original eighteen.
    PremiumMismatch,
    TermsHashMismatch,
    BadTermsJson,
    SwarmNotFound,
    PoolNotFound,
}

impl ContractError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::PolicyNotFound => "E01",
            Self::NotActive => "E02",
            Self::OutsideWindow => "E03",
            Self::UnknownAgent => "E04",
            Self::Duplicate => "E05",
            Self::BadSignatureJson => "E06",
            Self::GatewaySignature => "E07",
            Self::UnsupportedAlgo => "E08",
            Self::WrongModel => "E09",
            Self::TextMismatch(_) => "E10",
            Self::UnknownSigner => "E11",
            Self::Unparseable => "E12",
            Self::TaskMismatch => "E13",
            Self::ReceiptAlreadyPosted => "E14",
            Self::PoolExhausted => "E15",
            Self::WithdrawLocked => "E16",
            Self::Unauthorized => "E17",
            Self::Paused => "E18",
            Self::PremiumMismatch => "E19",
            Self::TermsHashMismatch => "E20",
            Self::BadTermsJson => "E21",
            Self::SwarmNotFound => "E22",
            Self::PoolNotFound => "E23",
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            Self::PolicyNotFound => "POLICY_NOT_FOUND",
            Self::NotActive => "NOT_ACTIVE",
            Self::OutsideWindow => "OUTSIDE_WINDOW",
            Self::UnknownAgent => "UNKNOWN_AGENT",
            Self::Duplicate => "DUPLICATE",
            Self::BadSignatureJson => "BAD_SIGNATURE_JSON",
            Self::GatewaySignature => "GATEWAY_SIGNATURE",
            Self::UnsupportedAlgo => "UNSUPPORTED_ALGO",
            Self::WrongModel => "WRONG_MODEL",
            Self::TextMismatch(_) => "TEXT_MISMATCH",
            Self::UnknownSigner => "UNKNOWN_SIGNER",
            Self::Unparseable => "UNPARSEABLE",
            Self::TaskMismatch => "TASK_MISMATCH",
            Self::ReceiptAlreadyPosted => "RECEIPT_ALREADY_POSTED",
            Self::PoolExhausted => "POOL_EXHAUSTED",
            Self::WithdrawLocked => "WITHDRAW_LOCKED",
            Self::Unauthorized => "UNAUTHORIZED",
            Self::Paused => "PAUSED",
            Self::PremiumMismatch => "PREMIUM_MISMATCH",
            Self::TermsHashMismatch => "TERMS_HASH_MISMATCH",
            Self::BadTermsJson => "BAD_TERMS_JSON",
            Self::SwarmNotFound => "SWARM_NOT_FOUND",
            Self::PoolNotFound => "POOL_NOT_FOUND",
        }
    }
}

impl fmt::Display for ContractError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TextMismatch(expected) => {
                write!(f, "{} TEXT_MISMATCH: expected {}", self.code(), expected)
            }
            other => write!(f, "{} {}", other.code(), other.name()),
        }
    }
}
