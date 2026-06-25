-- 高考志愿填报助手 - 数据库初始化
-- 数据库: gaokao_chat (请在 MySQL 中先创建此数据库)

CREATE TABLE IF NOT EXISTS chat_sessions (
    id            VARCHAR(36)  PRIMARY KEY,
    title         VARCHAR(100) NOT NULL DEFAULT '',
    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_created_at (created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS chat_messages (
    id            BIGINT       AUTO_INCREMENT PRIMARY KEY,
    session_id    VARCHAR(36)  NOT NULL,
    role          ENUM('user','assistant') NOT NULL,
    content       TEXT         NOT NULL,
    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_session_time (session_id, created_at),
    FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
