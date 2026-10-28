package api

import (
 "bytes"
 "context"
 "errors"
 "net/http"
 "os"
 "strings"
 "testing"
 "time"

 "github.com/Tencent/WeKnora/internal/logger"
)

func TestRelayRequestLogOmitsPrivatePayloads(t *testing.T) {
 var output bytes.Buffer
 logger.SetOutput(&output)
 logger.SetLogLevel(logger.LevelInfo)
 defer logger.SetOutput(os.Stdout)
 const private = "RELAY_PRIVATE_PROMPT_COMPLETION_TOKEN_CANARY"
 for _, body := range [][]byte{
  []byte(`{"messages":[{"role":"system","content":"RELAY_PRIVATE_PROMPT_COMPLETION_TOKEN_CANARY"},{"role":"user","content":"RELAY_PRIVATE_PROMPT_COMPLETION_TOKEN_CANARY"}],"reasoning_content":"RELAY_PRIVATE_PROMPT_COMPLETION_TOKEN_CANARY"}`),
  []byte(private),
 } {
  output.Reset()
  LogRequest(context.Background(), "https://private.invalid/?token="+private, private, body, true)
  logged := output.String()
  if strings.Contains(logged, private) || strings.Contains(logged, "role") || strings.Contains(logged, "reasoning_content") {
   t.Fatal("request logging disclosed private request fields")
  }
  if !strings.Contains(logged,"body_bytes=") || !strings.Contains(logged,"message_count=") || !strings.Contains(logged,"body_logged=false") {
   t.Fatal("request logging omitted required safe statistics")
  }
 }
}

func TestRelayModelErrorsOmitPrivateResponseAndURL(t *testing.T) {
 const private = "RELAY_PRIVATE_RESPONSE_TOKEN_CANARY"
 httpError := &HTTPError{StatusCode:429,Body:private,Header:http.Header{"Retry-After":[]string{"12"}}}
 if strings.Contains(httpError.Error(),private) || !strings.Contains(httpError.Error(),"429") { t.Fatal("HTTP error exposed response body or lost status") }
 if httpError.Body != private || httpError.RetryAfter()!=12*time.Second { t.Fatal("typed retry metadata was lost") }
 transport := &TransportError{Op:"send request",Err:errors.New("https://private.invalid/?token="+private)}
 if strings.Contains(transport.Error(),private) || !errors.Is(transport,transport.Err) { t.Fatal("transport error leaked a URL or lost typed cause") }
}

func TestRelayPrivateResponseStillClassifiesImageFallback(t *testing.T) {
 err := ModelResponseError("image input is unsupported; PRIVATE_RESPONSE", false)
 if !IsMultimodalNotSupportedError(err) { t.Fatal("private response capability classification was lost") }
 if strings.Contains(err.Error(), "PRIVATE_RESPONSE") { t.Fatal("private response leaked into error text") }
}
