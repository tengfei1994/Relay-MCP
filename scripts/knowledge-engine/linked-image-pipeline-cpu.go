// CPU-only replay of the real Markdown upload preprocessing path; emits hashes only.
package main

import (
 "bufio"
 "context"
 "crypto/sha256"
 "encoding/hex"
 "encoding/json"
 "os"
 "strings"
 "unicode/utf8"

 "github.com/Tencent/WeKnora/internal/infrastructure/chunker"
 "github.com/Tencent/WeKnora/internal/infrastructure/docparser"
 "github.com/Tencent/WeKnora/internal/logger"
 "github.com/Tencent/WeKnora/internal/types"
)

func hash(value string) string { sum:=sha256.Sum256([]byte(value)); return hex.EncodeToString(sum[:]) }
func main() {
 logger.SetLogLevel(logger.LevelWarn)
 input:=json.NewDecoder(bufio.NewReader(os.Stdin)); output:=json.NewEncoder(os.Stdout)
 // A canceled context makes accidental remote image fetches fail before connecting.
 ctx,cancel:=context.WithCancel(context.Background());cancel()
 for input.More() {
  var row map[string]string
  if input.Decode(&row)!=nil || !utf8.ValidString(row["content"]) { os.Exit(2) }
  result,err:=(&docparser.SimpleFormatReader{}).Read(ctx,&types.ReadRequest{FileType:"md",FileName:"structured.md",FileContent:[]byte(row["content"])})
  if err!=nil { os.Exit(3) }
  result.MarkdownContent=docparser.NormalizeHTMLTables(chunker.NormalizeLineEndings(result.MarkdownContent))
  expectedInput:=result.MarkdownContent
  resolver:=docparser.NewImageResolver()
  actual,inline,err:=resolver.ResolveAndStore(ctx,result,nil,1)
  if err!=nil || len(inline)!=0 { os.Exit(4) }
  actual,remote,err:=resolver.ResolveRemoteImages(ctx,actual,nil,1)
  if err!=nil || len(remote)!=0 { os.Exit(5) }
  chunks:=chunker.Split(actual,chunker.NormalizeSplitterConfig(chunker.SplitterConfig{}))
  hashes:=[]string{}
  for _,chunk:=range chunks { if strings.TrimSpace(chunk.Content)!="" { hashes=append(hashes,hash(chunk.Content)) } }
  value:=map[string]interface{}{"bulkSourceId":row["id"],"normalizedSha256":hash(row["content"]),"previewInputSha256":hash(expectedInput),"uploadInputSha256":hash(actual),"indexableChunkHashes":hashes,"indexableChunks":len(hashes),"remoteImages":len(remote),"inlineImages":len(inline)}
  if output.Encode(value)!=nil { os.Exit(6) }
 }
}
