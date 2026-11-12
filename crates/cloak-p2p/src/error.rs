use thiserror::Error;

/// Typed errors emitted by the local-first peer-to-peer storage, crypto, and transport engine.
#[derive(Debug, Error)]
pub enum P2pError {
    #[error("SQLite local vault error: {0}")]
    Storage(#[from] rusqlite::Error),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("Cryptographic verification or AEAD failure: {0}")]
    Crypto(String),

    #[error("Direct connectivity blocked ({mode}): {detail}")]
    DirectConnectivityBlocked { mode: String, detail: String },

    #[error("Peer handshake or authentication failed: {0}")]
    PeerRejected(String),

    #[error("Invalid wire protocol frame: {0}")]
    Protocol(String),

    #[error("Resource not found: {0}")]
    NotFound(String),

    #[error("Invalid input: {0}")]
    Validation(String),
}

pub type P2pResult<T> = Result<T, P2pError>;
