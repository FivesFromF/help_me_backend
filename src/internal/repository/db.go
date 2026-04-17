package repository

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/fivesfromf/helpme/internal/repository/sqlc"
)

type Store struct {
	*sqlc.Queries
	db *pgxpool.Pool
}

func NewStore(ctx context.Context, connString string) (*Store, error) {
	pool, err := pgxpool.New(ctx, connString)
	if err != nil {
		return nil, fmt.Errorf("unable to connect to database: %w", err)
	}

	if err := pool.Ping(ctx); err != nil {
		return nil, fmt.Errorf("unable to ping database: %w", err)
	}

	return &Store{
		Queries: sqlc.New(pool),
		db:      pool,
	}, nil
}

func (s *Store) Close() {
	s.db.Close()
}
