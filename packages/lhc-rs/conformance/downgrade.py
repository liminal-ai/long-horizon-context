import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
for stmt in (
    "ALTER TABLE turns DROP COLUMN outcome;",
    "ALTER TABLE turns DROP COLUMN outcome_reason;",
    "ALTER TABLE turns DROP COLUMN started_at;",
    "ALTER TABLE turns DROP COLUMN ended_at;",
    "ALTER TABLE message DROP COLUMN provider_usage;",
    "PRAGMA user_version = 4;",
):
    db.execute(stmt)
db.commit(); db.close()
print("downgraded to v4:", sys.argv[1])
