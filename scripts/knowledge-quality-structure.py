"""Independent, content-private HTML structure audit. No models; SQLite read only.

Uses Python's HTML parser rather than Relay's normalizer. Passing checks establish
specific structural/string invariants, never semantic correctness or rendering.
"""
import argparse, collections, datetime, hashlib, html, io, json, pathlib, posixpath, re, sqlite3, subprocess, sys, urllib.parse, urllib.request, zipfile
from html.parser import HTMLParser

ROOT = pathlib.Path('/home/ftd/relay-knowledge-engine-nonprod')
ARCHIVE_HASH = '256b2a52562f321f2788205605436e5e00272060ad76c20263c637672c4b7342'
MANIFEST_HASH = '712d0e78e9928123c402b748a3e966ef99eaf30121a7ff4ac76be3fe0ab30009'
INNER = '21.3 Docs/SampleManager Documentation.zip'
STRATA = ('headings', 'tables', 'code', 'images', 'links', 'anchors')
VOID = {'area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr'}
OMIT = {'head','script','style','nav','aside','footer','header'}

def sha(value): return hashlib.sha256(value.encode() if isinstance(value, str) else value).hexdigest()
def require(ok, code):
    if not ok: raise ValueError(code)
def compact(value): return re.sub(r'\s+', ' ', value.replace('\xa0', ' ')).strip()
def code_text(value): return value.replace('\r\n','\n').replace('\r','\n').strip('\n')

class Node:
    def __init__(self, tag, attrs=(), location=(0,0)):
        self.tag, self.attrs, self.location, self.children = tag, dict(attrs), location, []
        self.parent=None
    def text(self):
        return ''.join(x.text() if isinstance(x, Node) else x for x in self.children)

class Document(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=True)
        self.root=Node('root'); self.stack=[self.root]; self.feed(source); self.close()
    def handle_starttag(self, tag, attrs):
        node=Node(tag,attrs,self.getpos()); node.parent=self.stack[-1]; self.stack[-1].children.append(node)
        if tag=='br': node.children.append('\n')
        if tag not in VOID: self.stack.append(node)
    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag,attrs)
        if tag not in VOID: self.handle_endtag(tag)
    def handle_endtag(self, tag):
        for i in range(len(self.stack)-1,0,-1):
            if self.stack[i].tag==tag:
                del self.stack[i:]; return
    def handle_data(self, value): self.stack[-1].children.append(value)

def walk(node, omit=True):
    for child in node.children:
        if isinstance(child,Node) and (not omit or child.tag not in OMIT):
            yield child
            yield from walk(child,omit)

def features(source):
    dom=Document(source); nodes=list(walk(dom.root))
    headings=[{'level':int(n.tag[1]),'text':compact(n.text()),'location':n.location} for n in nodes if re.fullmatch('h[1-6]',n.tag) and compact(n.text())]
    tables=[]
    for n in nodes:
        if n.tag!='table': continue
        nested=any(x.tag=='table' for x in walk(n))
        rows=[]; spans=False;layout=[]
        for row in walk(n):
            if row.tag!='tr': continue
            cells=[c for c in row.children if isinstance(c,Node) and c.tag in ('td','th')]
            if cells:
                rows.append([compact(c.text()) for c in cells])
                layout.append([[c.attrs.get('rowspan','1'),c.attrs.get('colspan','1')] for c in cells])
                spans |= any(c.attrs.get('rowspan','1')!='1' or c.attrs.get('colspan','1')!='1' for c in cells)
        if rows: tables.append({'rows':rows,'layout':layout,'spans':spans,'nested':nested,'location':n.location})
    code=[{'text':code_text(n.text()),'location':n.location} for n in nodes if n.tag=='pre' and code_text(n.text())]
    def context(node):
        while node:
            if 'MCRelationshipsProxy' in node.attrs.get('class',''): return 'related_topic_reference'
            node=node.parent
        return 'content_reference'
    links=[{'target':n.attrs['href'],'label':compact(n.text()),'location':n.location,'context':context(n)} for n in nodes if n.tag=='a' and n.attrs.get('href') and not n.attrs['href'].lower().startswith(('javascript:','mailto:'))]
    images=[{'target':n.attrs['src'],'location':n.location} for n in nodes if n.tag=='img' and n.attrs.get('src')]
    anchors=[{'id':n.attrs.get('id') or n.attrs.get('name'),'location':n.location} for n in nodes if n.attrs.get('id') or (n.tag=='a' and n.attrs.get('name'))]
    # Skin logos and generic page scaffolding are inventoried separately. These
    # source-only exclusions apply to all pages before deterministic sampling.
    template_images=[x for x in images if '/Images-CSS-Skin/' in x['target']]
    template_anchors=[x for x in anchors if x['id'] in ('mc-main-content','skin-heading')]
    return dict(headings=headings,tables=tables,code=code,links=links,images=[x for x in images if x not in template_images],anchors=[x for x in anchors if x not in template_anchors],templateImages=template_images,templateAnchors=template_anchors)

def inline_plain(value):
    # Literal punctuation is escaped by the renderer. Protect it before
    # interpreting Markdown delimiters; image alt text is not DOM textContent.
    escaped=[]
    def keep(match):escaped.append(match[1]);return '\ue000'+str(len(escaped)-1)+'\ue001'
    value=re.sub(r'\\([\\`*\[\]|])',keep,value)
    value=re.sub(r'!\[[^\]]*\]\([^\n]*?\)','',value)
    value=re.sub(r'!?\[([^\]]*)\]\([^\n]*?\)',r'\1',value)
    value=re.sub(r'<[^>]*>','',value)
    value=re.sub(r'(`+)(.*?)\1',r'\2',value)
    value=re.sub(r'(\*\*|\*)(?=\S)(.*?)\1',r'\2',value)
    value=re.sub(r'(?<!\w)(__|_)(?=\S)(.*?)\1(?!\w)',r'\2',value)
    value=re.sub(r'\ue000(\d+)\ue001',lambda match:escaped[int(match[1])],value)
    return compact(html.unescape(value))

def markdown(body):
    headings=[]; table_rows=[]; blocks=[]; fence=None; collected=[];outside=[]
    for line in body.replace('\r\n','\n').split('\n'):
        marker=re.match(r'^ {0,3}(`{3,}|~{3,})(.*)$',line)
        if fence:
            if marker and marker[1][0]==fence[0] and len(marker[1])>=len(fence) and not marker[2].strip():
                blocks.append('\n'.join(collected)); fence=None; collected=[]
            else: collected.append(line)
            continue
        if marker: fence=marker[1]; continue
        outside.append(line)
        h=re.match(r'^(#{1,6})\s+(.+?)\s*#*\s*$',line)
        if h: headings.append((len(h[1]),inline_plain(h[2])))
        if line.strip().startswith('|') and line.strip().endswith('|'):
            cells=re.split(r'(?<!\\)\|',line.strip()[1:-1])
            if not all(re.fullmatch(r'\s*:?-+:?\s*',cell) for cell in cells): table_rows.append([inline_plain(cell) for cell in cells])
    # Capture balanced Markdown destinations, including paths with parentheses.
    refs={'links':[],'images':[]}
    for match in re.finditer(r'(!?)\[',body):
        depth=1; label_end=match.end()
        while label_end<len(body) and depth:
            if body[label_end]=='\\':label_end+=2;continue
            if body[label_end]=='[':depth+=1
            elif body[label_end]==']':depth-=1
            label_end+=1
        if depth or label_end>=len(body) or body[label_end]!='(':continue
        depth=1; start=label_end+1;end=start
        while end<len(body) and depth:
            if body[end]=='\\': end+=2; continue
            if body[end]=='(': depth+=1
            elif body[end]==')': depth-=1
            end+=1
        if depth==0: refs['images' if match[1] else 'links'].append(body[start:end-1].strip().strip('<>'))
    anchors=[n.attrs.get('id') or n.attrs.get('name') for n in walk(Document(body).root) if n.attrs.get('id') or n.attrs.get('name')]
    safe_html=features('\n'.join(outside))
    blocks.extend(x['text'] for x in safe_html['code'])
    for key in ('links','images'):refs[key].extend(x['target'] for x in safe_html[key])
    return dict(headings=headings,tableRows=table_rows,htmlTables=safe_html['tables'],code=blocks,anchors=anchors,**refs)

def sub_sequence(needles, values):
    cursor=0; matches=[]
    for item in needles:
        found=next((i for i in range(cursor,len(values)) if values[i]==item),None)
        matches.append(found)
        if found is not None: cursor=found+1
    return matches

def outcome(category, checks):
    failures=[x for x in checks if not x['preserved']]
    return {'category':category,'checked':len(checks),'preserved':len(checks)-len(failures),'findings':failures,
            'status':'not_applicable' if not checks else 'structural_invariant_satisfied' if not failures else 'structure_not_preserved_or_not_demonstrated'}

def compare(source, body, sections=None):
    md=markdown(body); result={}
    matches=sub_sequence([(x['level'],x['text']) for x in source['headings']],md['headings'])
    result['headings']=outcome('heading_level_text_and_order',[{'index':i,'sourceLocation':x['location'],'sha256':sha(json.dumps([x['level'],x['text']])),'preserved':matches[i] is not None} for i,x in enumerate(source['headings'])])
    checks=[]
    for i,table in enumerate(source['tables']):
        # Row/column values are compared as units, not loose keyword presence.
        found=next((start for start in range(len(md['tableRows'])) if md['tableRows'][start:start+len(table['rows'])]==table['rows']),None)
        html_match=any(value['rows']==table['rows'] and value['layout']==table['layout'] and value['nested']==table['nested'] for value in md['htmlTables'])
        checks.append({'index':i,'sourceLocation':table['location'],'sha256':sha(json.dumps(table['rows'])),'rows':len(table['rows']),'columns':[len(row) for row in table['rows']],
                       'sourceHasSpanOrNestedLayout':table['spans'] or table['nested'],'exactSafeHtmlLayoutMatch':html_match,'preserved':html_match or (found is not None and not(table['spans'] or table['nested']))})
    result['tables']=outcome('table_row_column_cell_relationship',checks)
    trim_lines=lambda value:'\n'.join(line.rstrip() for line in value.split('\n'))
    result['code']=outcome('decoded_code_exact_except_line_endings_and_framing_newlines',[{'index':i,'sourceLocation':x['location'],'sha256':sha(x['text']),'characters':len(x['text']),'preserved':x['text'] in [code_text(v) for v in md['code']],
        'equivalentAfterTrailingWhitespaceTrim':any(trim_lines(x['text'])==trim_lines(code_text(v)) for v in md['code'])} for i,x in enumerate(source['code'])])
    for key in ('links','images'):
        result[key]=outcome('original_'+key+'_destination',[{'index':i,'sourceLocation':x['location'],'targetSha256':sha(x['target']),'context':x.get('context','content_reference'),'preserved':x['target'] in md[key]} for i,x in enumerate(source[key])])
    result['anchors']=outcome('original_anchor_identifier',[{'index':i,'sourceLocation':x['location'],'anchorSha256':sha(x['id']),'preserved':x['id'] in md['anchors']} for i,x in enumerate(source['anchors'])])
    if sections is not None:
        result['sections']=outcome('heading_has_section_and_body_locator',[{'index':i,'sourceLocation':x['location'],'sha256':sha(x['text']),
           'preserved':any(inline_plain(str(s.get('title','')))==x['text'] and str(s.get('text','')) in body and bool(s.get('anchor')) for s in sections)} for i,x in enumerate(source['headings'])])
    return result

def locate_refs(source, entry, archive):
    names=set(archive.namelist()); out=[]
    for kind in ('links','images'):
        for index,item in enumerate(source[kind]):
            parsed=urllib.parse.urlsplit(item['target'])
            if parsed.scheme or parsed.netloc: status='external_reference_not_fetched'
            else:
                target=posixpath.normpath(posixpath.join(posixpath.dirname(entry),urllib.parse.unquote(parsed.path))) if parsed.path else entry
                if target not in names: status='source_archive_target_missing'
                elif parsed.fragment and kind=='links' and target.lower().endswith(('.htm','.html')):
                    target_source=archive.read(target).decode('utf-8-sig',errors='replace')
                    ids=[x['id'] for x in features(target_source)['anchors']]
                    status='source_target_and_anchor_found' if urllib.parse.unquote(parsed.fragment) in ids else 'source_target_anchor_missing'
                else: status='source_target_found'
            out.append({'kind':kind,'index':index,'targetSha256':sha(item['target']),'status':status})
    return out

def readonly(file):
    conn=sqlite3.connect('file:'+urllib.parse.quote(str(file))+'?mode=ro',uri=True,timeout=5);conn.row_factory=sqlite3.Row
    conn.execute('pragma query_only=ON');return conn
def private_write(file,value):
    require(file.parent.resolve().is_relative_to(ROOT/'runtime'),'report_outside_private_runtime')
    import os
    fd=os.open(file,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as stream: json.dump(value,stream,ensure_ascii=False,indent=2);stream.write('\n')
    return {'path':str(file),'sha256':sha(file.read_bytes())}

def inspect_chunks(relay,engine,local_id,source):
    mapping=relay.execute("SELECT w.* FROM knowledge_weknora_documents w JOIN knowledge_migration_documents m ON m.document_id=w.id WHERE m.local_document_id=? ORDER BY w.updated_at DESC LIMIT 1",(local_id,)).fetchone()
    if not mapping or not mapping['upstream_verified_at'] or mapping['status'] not in ('staged','published'): return {'status':'not_ready'}
    ids=json.loads(mapping['external_chunk_ids_json']); chunks=[dict(x) for x in engine.execute("SELECT id,content,chunk_index,chunk_type,start_at,end_at,is_enabled,index_status,deleted_at FROM chunks WHERE knowledge_id=? AND knowledge_base_id=? ORDER BY chunk_index,id",(mapping['external_document_id'],mapping['external_knowledge_base_id']))]
    selected=[x for x in chunks if x['id'] in ids and x['chunk_type']=='text' and x['is_enabled'] and x['index_status']=='ready' and x['deleted_at'] is None]
    if not selected: return {'status':'not_ready'}
    joined='\n'.join(x['content'] for x in selected)
    return {'status':'verified_staged_snapshot','externalDocumentId':mapping['external_document_id'],'mappingStatus':mapping['status'],
            'chunkCount':len(selected),'chunks':[{'id':x['id'],'index':x['chunk_index'],'sha256':sha(x['content']),'characters':len(x['content'])} for x in selected],
            'comparison':compare(source,joined),'assembly':'ordered_text_chunks_with_newlines_overlap_not_removed; cross_chunk_breaks_can_be_not_demonstrated',
            'semanticAccuracy':'not_evaluated'}

def discrepancy(relay,engine,bulk,row,preview=False):
    body=bulk.execute('SELECT body FROM knowledge_documents WHERE id=?',(row['bulkSourceId'],)).fetchone()['body']
    mapping=relay.execute('SELECT w.external_document_id FROM knowledge_weknora_documents w JOIN knowledge_migration_documents m ON m.document_id=w.id WHERE m.local_document_id=? ORDER BY w.updated_at DESC LIMIT 1',(row['targetLocalId'],)).fetchone()
    if not mapping:return {'status':'not_ready'}
    chunks=[dict(x) for x in engine.execute("SELECT chunk_index,content,start_at,end_at FROM chunks WHERE knowledge_id=? AND chunk_type='text' AND deleted_at IS NULL AND is_enabled=1 ORDER BY chunk_index",(mapping['external_document_id'],))]
    covered=[False]*len(body); exact=[]
    for chunk in chunks:
        start,end=chunk['start_at'],chunk['end_at'];good=0<=start<=end<=len(body) and body[start:end]==chunk['content'];exact.append(good)
        if good:covered[start:end]=[True]*(end-start)
    gaps=[];start=None
    for i,found in enumerate(covered+[True]):
        if not found and start is None:start=i
        if found and start is not None:
            value=body[start:i];gaps.append({'start':start,'end':i,'sha256':sha(value),'characters':len(value),'whitespaceOnly':not value.strip()});start=None
    out={'targetLocalId':row['targetLocalId'],'sourcePath':row['sourcePath'],'bodySha256':sha(body),'frozenPreview':row['preview'],'actualTextChunks':len(chunks),
         'actualIndices':[x['chunk_index'] for x in chunks],'allContentMatchesOriginalCharacterRanges':all(exact),'uncoveredRanges':gaps,'uncoveredNonWhitespaceCharacters':sum(1 for i,c in enumerate(body) if not covered[i] and not c.isspace())}
    if preview:
        runtime=json.loads((ROOT/'runtime/knowledge-engine/engine.json').read_text());control=json.loads((ROOT/'runtime/knowledge-engine/control.json').read_text())
        def request(path,payload=None):
            req=urllib.request.Request(runtime['baseUrl']+path,data=None if payload is None else json.dumps(payload).encode(),headers={'X-API-Key':control['apiKey'],'Content-Type':'application/json'})
            with urllib.request.urlopen(req,timeout=15) as response:return json.load(response)
        config=request('/api/v1/knowledge-bases/'+control['knowledgeBaseId'])['data']['chunking_config']
        result=request('/api/v1/chunker/preview',{'text':body,'chunking_config':config})
        data=result.get('data',result);items=data.get('chunks',[])
        out['cpuOnlyPreview']={'chunkCount':len(items),'stats':data.get('stats'),'zeroModelCalls':True,'chunks':[{'index':x['seq'],'sha256':sha(x['content']),'characters':len(x['content']),'whitespaceOnly':not x['content'].strip(),'matchesIndexedChunk':any(c['chunk_index']==x['seq'] and c['content']==x['content'] for c in chunks)} for x in items]}
    out['classification']='whitespace_only_chunk_filter_no_nonwhitespace_body_loss' if all(exact) and gaps and all(x['whitespaceOnly'] for x in gaps) else 'requires_investigation'
    return out

def self_test():
    raw='<html><head><title>Ignored</title></head><body><h1 id="root">Title</h1><h2>Child</h2><table><tr><th>A</th><th>B</th></tr><tr><td>one</td><td>two</td></tr></table><pre>&lt;x&gt;\n  exact &amp; value</pre><a href="other.htm#part">Other</a><img src="image.png"><a name="old"></a></body></html>'
    body='<a id="root"></a>\n# Title\n## Child\n| A | B |\n| --- | --- |\n| one | two |\n```\n<x>\n  exact & value\n```\n[Other](other.htm#part)\n![](image.png)\n<a id="old"></a>'
    source=features(raw);result=compare(source,body)
    assert all(x['status']=='structural_invariant_satisfied' for x in result.values())
    changed=compare(source,body.replace('| one | two |','| two | one |').replace('  exact',' exact').replace('## Child','# Child').replace('id="old"','id="changed"'))
    assert all(changed[x]['findings'] for x in ('tables','code','headings','anchors'))
    assert compare(source,body.replace('image.png','other.png'))['images']['findings']
    assert inline_plain('WEB_CLIENT_USER_AGENT')=='WEB_CLIENT_USER_AGENT'
    assert inline_plain('**WEB_CLIENT_USER_AGENT**')=='WEB_CLIENT_USER_AGENT'
    assert inline_plain('part*formatted*word')=='partformattedword'
    assert inline_plain(r'literal \* \[value\] C:\\folder')=='literal * [value] C:\\folder'
    assert inline_plain('[![](icon.png)](target.htm)')==''
    complex_table='<table><tr><td colspan="2"><a href="one.htm">One</a></td></tr></table>'
    assert compare(features(complex_table),complex_table)['tables']['preserved']==1
    assert compare(features(complex_table),complex_table.replace('colspan="2"','colspan="3"'))['tables']['findings']
    image_features=features('<img src="../GlobalStyles/Images-CSS-Skin/logo.png"><img src="../Resources/screen.png">')
    assert len(image_features['images'])==1 and image_features['images'][0]['target']=='../Resources/screen.png'
    print(json.dumps({'selfTest':'passed','modelCalls':0}))

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--self-test',action='store_true');parser.add_argument('--report');parser.add_argument('--per-stratum',type=int,default=3);parser.add_argument('--diagnostic-id');parser.add_argument('--cpu-preview',action='store_true');parser.add_argument('--candidate-renderer');parser.add_argument('--selection-report');parser.add_argument('--all',action='store_true');parser.add_argument('--candidate-stream',action='store_true');args=parser.parse_args()
    if args.self_test:self_test();return
    require(sys.platform=='linux' and ROOT.resolve()==ROOT,'nonproduction_root_required');require(1<=args.per_stratum<=10,'sample_limit_invalid')
    report_path=pathlib.Path(args.report);require(report_path.is_absolute(),'absolute_report_required')
    archive_path=ROOT/'sources/21.3 Docs.zip';manifest_path=ROOT/'runtime/full-213/manifest.jsonl'
    archive_digest=hashlib.sha256()
    with archive_path.open('rb') as stream:
        for block in iter(lambda:stream.read(1024*1024),b''):archive_digest.update(block)
    require(archive_digest.hexdigest()==ARCHIVE_HASH,'archive_hash_changed');require(sha(manifest_path.read_bytes())==MANIFEST_HASH,'manifest_hash_changed')
    manifest=[json.loads(x) for x in manifest_path.read_text().splitlines() if x];require(len(manifest)==5372,'manifest_count_changed')
    outer=zipfile.ZipFile(archive_path);archive=zipfile.ZipFile(io.BytesIO(outer.read(INNER)))
    names=set(archive.namelist());features_by_id={};entries={};coverage=collections.Counter();candidates={k:[] for k in STRATA}
    # Selection reads only source HTML and manifest identity. No Relay body,
    # chunk result or preservation verdict is used to select these pages.
    for row in manifest:
        match=re.search(r'\.zip\.expanded-[^/]+/(.+)$',row['sourcePath']);require(match is not None,'unrecognized_source_path')
        entry=match[1];require(entry in names,'source_archive_entry_missing');raw=archive.read(entry);require(sha(raw)==row['rawSha256'],'raw_source_hash_changed')
        source=features(raw.decode('utf-8-sig',errors='replace'));entries[row['targetLocalId']]=entry
        score=sha('structure-v1|'+row['sourcePath']+'|'+row['rawSha256'])
        for key in STRATA:
            if source[key]: candidates[key].append((score,row['targetLocalId']));coverage[key]+=1
    chosen={key:[id for _,id in sorted(values)[:args.per_stratum]] for key,values in candidates.items()}
    if args.selection_report:
        prior_path=pathlib.Path(args.selection_report);require(prior_path.resolve().is_relative_to(ROOT/'runtime'),'selection_outside_runtime')
        prior=json.loads(prior_path.read_text());require(prior['manifestSha256']==MANIFEST_HASH,'selection_manifest_changed');chosen=prior['sampling']['selected']
    selected=set(id for values in chosen.values() for id in values);by_id={row['targetLocalId']:row for row in manifest}
    if args.all:
        require(not args.selection_report,'all_conflicts_with_selection');selected=set(by_id)
    if args.diagnostic_id:require(args.diagnostic_id in by_id,'diagnostic_source_missing')
    bulk=readonly(ROOT/'bulk/knowledge.db');relay=readonly(ROOT/'relay/data/knowledge.db');engine=readonly(ROOT/'runtime/knowledge-engine/data/weknora.db')
    samples=[];candidate_process=None
    if args.candidate_stream:
        require(bool(args.candidate_renderer),'candidate_renderer_required')
        candidate_path=pathlib.Path(args.candidate_renderer);require(candidate_path.resolve().is_relative_to(ROOT/'runtime'),'candidate_outside_runtime')
        candidate_process=subprocess.Popen(['node',str(candidate_path),'--stream'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,encoding='utf-8')
    try:
        for id in sorted(selected):
            row=by_id[id];entry=entries[id];source=features(archive.read(entry).decode('utf-8-sig',errors='replace'))
            local=bulk.execute('SELECT d.body,p.sections_json FROM knowledge_documents d JOIN knowledge_product_documents p ON p.id=d.id WHERE d.id=?',(row['bulkSourceId'],)).fetchone()
            require(local is not None and sha(local['body'])==row['bodySha256'] and sha(local['sections_json'])==row['sectionsSha256'],'frozen_bulk_structure_changed')
            sample={'targetLocalId':id,'bulkSourceId':row['bulkSourceId'],'sourcePath':row['sourcePath'],'archiveEntry':entry,'rawSha256':row['rawSha256'],'bodySha256':row['bodySha256'],'sectionsSha256':row['sectionsSha256'],
                            'selectedFor':[key for key,ids in chosen.items() if id in ids],'sourceCounts':{key:len(source[key]) for key in STRATA},'excludedTemplateCounts':{key:len(source[key]) for key in ('templateImages','templateAnchors')},'relay':compare(source,local['body'],json.loads(local['sections_json'])),
                            'sourceReferenceLocation':{'status':'not_evaluated_in_full_candidate_scan'} if args.all else locate_refs(source,entry,archive),'engine':{'status':'not_evaluated_in_full_candidate_scan'} if args.all else inspect_chunks(relay,engine,id,source)}
            if args.candidate_renderer:
                candidate_path=pathlib.Path(args.candidate_renderer);require(candidate_path.resolve().is_relative_to(ROOT/'runtime'),'candidate_outside_runtime')
                raw_html=archive.read(entry).decode('utf-8-sig',errors='replace')
                if candidate_process:
                    candidate_process.stdin.write(json.dumps(raw_html)+'\n');candidate_process.stdin.flush();candidate=json.loads(candidate_process.stdout.readline())
                else:candidate=json.loads(subprocess.run(['node',str(candidate_path)],input=raw_html,capture_output=True,text=True,check=True,timeout=30).stdout)
                sample['candidate']={'bodySha256':sha(candidate['markdown']),'nonEmpty':bool(candidate['markdown'].strip()),'idempotent':candidate['idempotent'],'comparison':compare(source,candidate['markdown']),'semanticAccuracy':'not_evaluated','persisted':False}
            samples.append(sample)
            if args.all and len(samples)%100==0:print(json.dumps({'progress':len(samples),'total':len(selected),'candidateFindingPages':sum(any(x['findings'] for x in s['candidate']['comparison'].values()) or not s['candidate']['idempotent'] or not s['candidate']['nonEmpty'] for s in samples),'modelCalls':0}),flush=True)
        diagnostic=discrepancy(relay,engine,bulk,by_id[args.diagnostic_id],args.cpu_preview) if args.diagnostic_id else None
    finally:
        bulk.close();relay.close();engine.close()
        if candidate_process:
            candidate_process.stdin.close();candidate_process.wait(timeout=10)
    failures={key:sum(len(sample['relay'][key]['findings']) for sample in samples) for key in (*STRATA,'sections')}
    report={'schemaVersion':2,'completedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'modelCalls':0,'sourceArchiveSha256':ARCHIVE_HASH,'manifestSha256':MANIFEST_HASH,'manifestCount':len(manifest),
            'sampling':{'method':'all_frozen_manifest_pages' if args.all else 'source_feature_strata_sha256_order_before_output_inspection','perStratum':None if args.all else args.per_stratum,'coverage':dict(coverage),'selected':{} if args.all else chosen,'uniqueSamples':len(samples)},
            'scope':'decoded DOM structure versus persisted Markdown or safe HTML; table cells/order/spans checked structurally, not browser rendering or semantic correctness; code stratum means pre elements',
            'sourceTemplateExclusions':{'tags':sorted(OMIT),'imagePathContains':'/Images-CSS-Skin/','anchorIds':['mc-main-content','skin-heading'],'relatedTopicReferences':'retained with separate context classification'},
            'snapshotConsistency':'independent read-only SQLite statements while migration continues; not a cross-database atomic snapshot',
            'summary':{'relayFindingsByCategory':failures,'engineNotReady':sum(x['engine']['status']=='not_ready' for x in samples),**({'candidateFindingsByCategory':{key:sum(len(sample['candidate']['comparison'][key]['findings']) for sample in samples) for key in STRATA},'candidateIdempotent':all(sample['candidate']['idempotent'] for sample in samples),'candidateNonEmpty':all(sample['candidate']['nonEmpty'] for sample in samples)} if args.candidate_renderer else {})},'samples':samples,'separateDiagnosticNotPartOfSample':diagnostic,
            'semanticAccuracy':'not_evaluated','status':'completed_with_structure_findings' if any(failures.values()) else 'sampled_structural_invariants_only'}
    saved=private_write(report_path,report);print(json.dumps({'status':report['status'],'report':saved,'sampling':report['sampling'],'summary':report['summary'],'diagnosticClassification':diagnostic.get('classification') if diagnostic else None,'modelCalls':0}))

if __name__=='__main__':
    try:main()
    except Exception as error:
        # Only our fixed invariant codes may leave the private process.
        message=str(error)
        code=message if isinstance(error,ValueError) and re.fullmatch('[a-z_]+',message) else 'structure_audit_failed_no_content_logged'
        print(json.dumps({'status':'failed','code':code}),file=sys.stderr);sys.exit(1)
