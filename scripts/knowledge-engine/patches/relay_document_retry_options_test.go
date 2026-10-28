package service

import (
 "encoding/json"
 "os"
 "testing"

 "github.com/hibiken/asynq"
)

func relayRetryValues(options []asynq.Option) []int {
 values:=[]int{}
 for _,option:=range options { if option.Type()==asynq.MaxRetryOpt { values=append(values,option.Value().(int)) } }
 return values
}

func TestRelayManagedDocumentTaskRetryOptions(t *testing.T) {
 t.Setenv("RELAY_MANAGED_DOCUMENT_PROCESS_NO_RETRY","true")
 values:=relayRetryValues(documentProcessTaskOptions(nil,asynq.MaxRetry(3)))
 // The router proof consumes these actual options, not a hand-authored fixture.
 if path:=os.Getenv("RELAY_RETRY_OPTIONS_PROOF");path!="" {
  payload,_:=json.Marshal(map[string]interface{}{"managedRetryOptions":values})
  if err:=os.WriteFile(path,append(payload,'\n'),0600);err!=nil { t.Fatal("could not write private options proof") }
 }
 if len(values)==0 || values[len(values)-1]!=0 { t.Fatal("managed document options permit an automatic retry") }
 for _,extra:=range []int{0,3,7} {
  values=relayRetryValues(documentProcessTaskOptions(nil,asynq.MaxRetry(extra)))
  if values[len(values)-1]!=0 { t.Fatal("caller extra retry option overrides managed zero retries") }
 }
}

func TestRelayManagedDocumentRetryLeavesOtherPoliciesUnchanged(t *testing.T) {
 for _,value:=range []string{"","false"} {
  t.Setenv("RELAY_MANAGED_DOCUMENT_PROCESS_NO_RETRY",value)
  values:=relayRetryValues(documentProcessTaskOptions(nil));if values[len(values)-1]!=3 { t.Fatal("nonmanaged default changed") }
  values=relayRetryValues(documentProcessTaskOptions(nil,asynq.MaxRetry(7)));if values[len(values)-1]!=7 { t.Fatal("nonmanaged extra option changed") }
 }
 t.Setenv("RELAY_MANAGED_DOCUMENT_PROCESS_NO_RETRY","true")
 values:=relayRetryValues(knowledgePostProcessTaskOptions());if values[len(values)-1]!=3 { t.Fatal("unrelated postprocess task retries changed") }
}
