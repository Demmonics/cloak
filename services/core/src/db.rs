use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;

use crate::error::CloakError;

pub async fn connect_and_migrate(
    database_url: &str,
    max_connections: u32,
) -> Result<PgPool, CloakError> {
    let pool = PgPoolOptions::new()
        .max_connections(max_connections)
        .connect(database_url)
        .await?;

    sqlx::migrate!("../../migrations")
        .run(&pool)
        .await
        .map_err(|e| CloakError::Internal(format!("migration failed: {e}")))?;

    Ok(pool)
}
