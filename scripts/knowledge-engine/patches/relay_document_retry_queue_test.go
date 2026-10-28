package router

import (
 "context"
 "encoding/json"
 "errors"
 "os"
 "sync/atomic"
 "testing"
 "time"

 "github.com/Tencent/WeKnora/internal/types"
 "github.com/hibiken/asynq"
)

func TestRelayManagedDocumentSingleQueueAttempt(t *testing.T) {
 path:=os.Getenv("RELAY_RETRY_OPTIONS_PROOF")
 if path=="" { t.Skip("the managed build runs the service options proof before this queue proof") }
 data,err:=os.ReadFile(path);if err!=nil { t.Fatal("service options proof missing") }
 var proof struct { ManagedRetryOptions []int `json:"managedRetryOptions"` }
 if json.Unmarshal(data,&proof)!=nil || len(proof.ManagedRetryOptions)==0 { t.Fatal("invalid service options proof") }
 options:=[]asynq.Option{}
 for _,value:=range proof.ManagedRetryOptions { options=append(options,asynq.MaxRetry(value)) }
 var calls atomic.Int32
 observed:=make(chan [2]int,1);finished:=make(chan struct{},1)
 executor:=NewSyncTaskExecutor()
 executor.RegisterHandler(types.TypeDocumentProcess,func(ctx context.Context,task *asynq.Task) error {
  calls.Add(1);attempt,limit,ok:=types.TaskRetryMetadataFromContext(ctx)
  if !ok { observed<-[2]int{-1,-1} } else { observed<-[2]int{attempt,limit} }
  return errors.New("controlled_retryable_failure")
 })
 executor.SetFinalFailureHook(func(context.Context,*asynq.Task,error){finished<-struct{}{}})
 if _,err=executor.Enqueue(asynq.NewTask(types.TypeDocumentProcess,[]byte(`{}`),options...));err!=nil { t.Fatal("queue rejected task") }
 select {case state:=<-observed:if state!=[2]int{0,0} { t.Fatal("actual Lite queue has a nonzero retry budget") };case <-time.After(time.Second):t.Fatal("task did not execute")}
 select {case <-finished:case <-time.After(time.Second):t.Fatal("task did not finish after its first failure")}
 if calls.Load()!=1 { t.Fatal("Lite queue executed a paid document task more than once") }
}
