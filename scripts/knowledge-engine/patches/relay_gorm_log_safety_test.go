package container

import (
	"bytes"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gorm.io/gorm"
	gormlogger "gorm.io/gorm/logger"
)

// Exercise initDatabase's actual runtime wiring, rather than a standalone logger.
// Rebind Default only to capture the pre-patch logger constructed at package init.
func TestRelayGormRuntimeTraceOmitsBoundValues(t *testing.T) {
	output, err := os.CreateTemp(t.TempDir(), "gorm-trace-*")
	if err != nil {
		t.Fatal(err)
	}
	previousStdout, previousDefault := os.Stdout, gormlogger.Default
	os.Stdout = output
	gormlogger.Default = gormlogger.New(log.New(output, "\r\n", log.LstdFlags), gormlogger.Config{
		SlowThreshold: 200 * time.Millisecond, LogLevel: gormlogger.Warn,
		IgnoreRecordNotFoundError: false, Colorful: true,
	})
	t.Cleanup(func() { os.Stdout = previousStdout; gormlogger.Default = previousDefault; output.Close() })
	t.Setenv("DB_DRIVER", "sqlite")
	t.Setenv("DB_PATH", filepath.Join(t.TempDir(), "privacy.db"))
	t.Setenv("AUTO_MIGRATE", "false")
	db, err := initDatabase(nil)
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { sqlDB.Close() })
	if err := db.Exec("CREATE TABLE relay_privacy_values (id INTEGER PRIMARY KEY, term TEXT, vector BLOB)").Error; err != nil {
		t.Fatal(err)
	}
	const canary = "SYNTHETIC_PRIVATE_QUERY_CANARY_0010"
	vector := []byte("SYNTHETIC_PRIVATE_VECTOR_CANARY_0010:[0.125,-0.25,0.5]")
	if err := db.Exec("INSERT INTO relay_privacy_values(id, term, vector) VALUES (?, ?, ?)", 1, canary, vector).Error; err != nil {
		t.Fatal(err)
	}
	type value struct {
		ID     int
		Term   string
		Vector []byte
	}
	readOutput := func() string {
		t.Helper()
		if _, err := output.Seek(0, io.SeekStart); err != nil {
			t.Fatal(err)
		}
		raw, err := io.ReadAll(output)
		if err != nil {
			t.Fatal(err)
		}
		return string(raw)
	}
	checkPrivate := func(t *testing.T, trace string) {
		t.Helper()
		if strings.Contains(trace, canary) || strings.Contains(trace, string(vector)) || strings.Contains(trace, "53594e5448455449435f505249564154455f564543544f52") {
			t.Fatal("GORM trace exposed a synthetic bound query/vector value")
		}
		if !strings.Contains(trace, "?") || !strings.Contains(trace, "ms]") || !strings.Contains(trace, "[rows:") {
			t.Fatal("GORM trace lost parameter placeholders, duration or row-count diagnostics")
		}
	}
	resetOutput := func(t *testing.T) {
		t.Helper()
		if err := output.Truncate(0); err != nil {
			t.Fatal(err)
		}
		if _, err := output.Seek(0, io.SeekStart); err != nil {
			t.Fatal(err)
		}
	}
	t.Run("info", func(t *testing.T) {
		resetOutput(t)
		var got value
		err := db.Session(&gorm.Session{Logger: db.Logger.LogMode(gormlogger.Info)}).Table("relay_privacy_values").Where("term = ? AND vector = ?", canary, vector).First(&got).Error
		if err != nil || got.Term != canary || !bytes.Equal(got.Vector, vector) {
			t.Fatalf("real SQLite result mismatch: %v", err)
		}
		trace := readOutput()
		checkPrivate(t, trace)
		if !strings.Contains(trace, "[rows:1]") {
			t.Fatal("missing successful row-count diagnostic")
		}
	})
	t.Run("info_scan", func(t *testing.T) {
		resetOutput(t)
		var got value
		err := db.Session(&gorm.Session{Logger: db.Logger.LogMode(gormlogger.Info)}).Raw("SELECT id, term, vector FROM relay_privacy_values WHERE term = ? AND vector = ?", canary, vector).Scan(&got).Error
		if err != nil || got.Term != canary || !bytes.Equal(got.Vector, vector) {
			t.Fatalf("real SQLite Scan result mismatch: %v", err)
		}
		trace := readOutput()
		checkPrivate(t, trace)
		if !strings.Contains(trace, "[rows:1]") {
			t.Fatal("missing Scan row-count diagnostic")
		}
	})
	t.Run("slow_warn", func(t *testing.T) {
		resetOutput(t)
		if err := db.Callback().Query().Before("gorm:query").Register("relay:synthetic_slow_query", func(*gorm.DB) { time.Sleep(225 * time.Millisecond) }); err != nil {
			t.Fatal(err)
		}
		defer db.Callback().Query().Remove("relay:synthetic_slow_query")
		var got value
		if err := db.Table("relay_privacy_values").Where("term = ? AND vector = ?", canary, vector).First(&got).Error; err != nil {
			t.Fatal(err)
		}
		if got.Term != canary || !bytes.Equal(got.Vector, vector) {
			t.Fatal("slow query lost real result")
		}
		trace := readOutput()
		checkPrivate(t, trace)
		if !strings.Contains(trace, "SLOW SQL >= 200ms") {
			t.Fatal("missing original slow-query threshold diagnostic")
		}
	})
	t.Run("error", func(t *testing.T) {
		resetOutput(t)
		var got value
		if err := db.Raw("SELECT relay_missing_function(?, ?)", canary, vector).Scan(&got).Error; err == nil {
			t.Fatal("expected SQLite function error")
		}
		trace := readOutput()
		checkPrivate(t, trace)
		if !strings.Contains(trace, "no such function: relay_missing_function") {
			t.Fatal("missing SQL error diagnostic")
		}
	})
	t.Run("record_not_found", func(t *testing.T) {
		resetOutput(t)
		var got value
		if err := db.Table("relay_privacy_values").Where("term = ?", canary+"_absent").First(&got).Error; err != gorm.ErrRecordNotFound {
			t.Fatalf("expected record-not-found: %v", err)
		}
		trace := readOutput()
		checkPrivate(t, trace)
		if !strings.Contains(trace, "record not found") {
			t.Fatal("record-not-found policy changed")
		}
	})
}
