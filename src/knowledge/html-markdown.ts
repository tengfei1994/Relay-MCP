import {parse,parseFragment,type DefaultTreeAdapterTypes as Tree} from "parse5";

type Node=Tree.Node;
type Element=Tree.Element;
export interface DomMarkdown {markdown:string;title?:string;anchors:string[];links:string[];images:string[];stableIdentifiers:Record<string,string>;sourceFormat:"madcap-html"|"innovasys-html"|"html";}
const OMIT=new Set(["head","script","style","nav","aside","footer","header","iframe","object","embed","template","noscript"]);
const SAFE_HTML=new Set(["table","thead","tbody","tfoot","tr","td","th","caption","colgroup","col","p","div","span","a","img","br","strong","b","em","i","code","pre","ul","ol","li","sub","sup","s","del"]);
const BLOCK=new Set(["p","div","section","article","main","figure","figcaption","details","summary","dl","dt","dd"]);
const element=(node:Node):node is Element=>"tagName" in node;
const children=(node:Node):Node[]=>"childNodes" in node?node.childNodes:[];
const attr=(node:Element,name:string)=>node.attrs.find(value=>value.name===name)?.value;
function all(node:Node):Element[]{return children(node).flatMap(child=>element(child)?[child,...all(child)]:all(child));}
function text(node:Node):string {return element(node)&&node.tagName==="br"?"\n":"value" in node?node.value:children(node).map(text).join("");}
const escaped=(value:string)=>value.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const compact=(value:string)=>value.replace(/\s+/g," ").trim();
function mdText(value:string):string {return value.replace(/\s+/g," ").replace(/\\/g,"\\\\").replace(/([`*\[\]])/g,"\\$1").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
function safeUrl(value:string|undefined):string|undefined {
  if(!value||/[\u0000-\u001f\u007f]/.test(value))return undefined;
  const trimmed=value.trim();
  if(/^[a-z][a-z0-9+.-]*:/i.test(trimmed)&&!/^https?:|^mailto:|^tel:/i.test(trimmed))return undefined;
  return trimmed||undefined;
}
function destination(value:string):string {const result=value.replace(/</g,"%3C").replace(/>/g,"%3E");return /[\s()]/.test(result)?`<${result}>`:result;}
function omitted(node:Element):boolean {
  if(OMIT.has(node.tagName)||attr(node,"id")==="skin-heading")return true;
  const classes=(attr(node,"class")??"").split(/\s+/);
  return classes.some(value=>["title-bar-container","sidenav-wrapper","MCBreadcrumbsBox_0"].includes(value));
}

class Renderer {
  anchors=new Set<string>();links=new Set<string>();images=new Set<string>();
  private literals:string[]=[];
  private prefix:string;
  constructor(source:string){this.prefix="\uE000RELAY_DOM_LITERAL_";while(source.includes(this.prefix))this.prefix+="_";}
  keep(value:string):string {return this.prefix+(this.literals.push(value)-1)+"\uE001";}
  restore(value:string):string {return this.literals.reduceRight((result,item,index)=>result.split(this.prefix+index+"\uE001").join(item),value);}
  private anchor(node:Element):string {
    return [attr(node,"id"),node.tagName==="a"?attr(node,"name"):undefined].filter((value):value is string=>Boolean(value)).map(id=>{
      if(this.anchors.has(id))return "";this.anchors.add(id);return `<a id="${escaped(id)}"></a>`;
    }).join("");
  }
  private body(node:Node):string {return children(node).map(child=>this.render(child)).join("");}
  private inline(node:Node):string {return this.body(node).replace(/\s*\n\s*/g," ").trim();}
  private list(node:Element):string {
    const start=Number(attr(node,"start")??1);let index=0;
    return "\n\n"+children(node).map(item=>{
      // Help exports include explanatory paragraphs/images between list items.
      // Keep their source position; only actual li nodes advance numbering.
      if(!element(item)||item.tagName!=="li")return this.render(item);
      const bullet=node.tagName==="ol"?`${Number.isInteger(start)?start+index++:++index}. `:"- ";
      const value=(this.anchor(item)+this.body(item)).trim().replace(/\n{3,}/g,"\n\n");
      return bullet+value.replace(/\n/g,"\n"+" ".repeat(bullet.length));
    }).join("\n")+"\n\n";
  }
  private table(node:Element):string {
    const descendants=all(node);
    // GFM cannot represent spans, nested tables or block-rich cells. Keep a
    // sanitized, canonical HTML table rather than flattening their relationships.
    const complex=descendants.some(n=>n.tagName==="table"||["pre","ul","ol","br"].includes(n.tagName)||Number(attr(n,"rowspan")??1)!==1||Number(attr(n,"colspan")??1)!==1||
      (n.tagName==="code"&&/[|\r\n]/.test(text(n)))||(["td","th"].includes(n.tagName)&&children(n).filter(c=>element(c)&&BLOCK.has(c.tagName)).length>1));
    if(complex)return "\n\n"+this.keep(this.safeHtml(node,true))+"\n\n";
    const rows=descendants.filter(n=>n.tagName==="tr");
    const rendered=rows.map(row=>{
      const cells=children(row).filter((n):n is Element=>element(n)&&["td","th"].includes(n.tagName));
      return {header:cells.some(n=>n.tagName==="th"),cells:cells.map((cell,index)=>{
        const content=(index===0?this.anchor(row):"")+this.anchor(cell)+this.body(cell).trim();
        return content.replace(/\n+/g,"<br>").replace(/\|/g,"\\|").trim();
      })};
    }).filter(row=>row.cells.length);
    if(!rendered.length)return "";
    const width=Math.max(...rendered.map(row=>row.cells.length));
    const line=(cells:string[])=>"| "+[...cells,...Array<string>(width-cells.length).fill("")].join(" | ")+" |";
    const header=rendered[0].header?rendered.shift()!.cells:Array<string>(width).fill("");
    const containerAnchors=descendants.filter(n=>["thead","tbody","tfoot","caption","colgroup","col"].includes(n.tagName)).map(n=>this.anchor(n)).join("");
    const caption=descendants.filter(n=>n.tagName==="caption").map(n=>this.inline(n)).join(" ");
    return "\n\n"+containerAnchors+(containerAnchors?"\n":"")+(caption?caption+"\n\n":"")+[line(header),line(Array<string>(width).fill("---")),...rendered.map(row=>line(row.cells))].join("\n")+"\n\n";
  }
  /** Strict allowlist: no scripts, style, handlers, active URLs or fetches. */
  safeHtml(node:Node,canonicalRoot=false):string {
    if(!element(node))return "value" in node?escaped(node.value):children(node).map(n=>this.safeHtml(n)).join("");
    if(omitted(node))return "";
    if(!SAFE_HTML.has(node.tagName))return children(node).map(n=>this.safeHtml(n)).join("");
    const attributes:string[]=[];
    if(canonicalRoot)attributes.push(`data-relay-structure="${node.tagName}"`);
    for(const name of ["id","name","rowspan","colspan","scope","start","title","alt"]){
      const value=attr(node,name);if(value===undefined)continue;
      if(["rowspan","colspan","start"].includes(name)&&!/^\d{1,5}$/.test(value))continue;
      if(name==="id"||name==="name")this.anchors.add(value);
      attributes.push(`${name}="${escaped(value)}"`);
    }
    if(node.tagName==="a") {const href=safeUrl(attr(node,"href"));if(href){attributes.push(`href="${escaped(href)}"`);this.links.add(href);}}
    if(node.tagName==="img") {
      const src=safeUrl(attr(node,"src"));if(!src||src.includes("/Images-CSS-Skin/"))return "";
      attributes.push(`src="${escaped(src)}"`);this.images.add(src);
    }
    return `<${node.tagName}${attributes.length?" "+attributes.join(" "):""}>`+(["img","br","col"].includes(node.tagName)?"":children(node).map(n=>this.safeHtml(n)).join("")+`</${node.tagName}>`);
  }
  render(node:Node):string {
    if(!element(node))return "value" in node?mdText(node.value):this.body(node);
    if(omitted(node))return "";
    const tag=node.tagName,classes=(attr(node,"class")??"").split(/\s+/);
    // Complex-table id stays on its original node in the safe HTML tree.
    if(tag==="table") {
      const value=this.table(node);
      return this.anchor(node)+value;
    }
    const anchor=this.anchor(node);
    const depth=/^h[1-6]$/.test(tag)?Number(tag[1]):classes.includes("i-page-title-text")?1:classes.includes("i-section-heading")?2:undefined;
    if(depth)return "\n\n"+anchor+(anchor?"\n":"")+"#".repeat(depth)+" "+this.inline(node)+"\n\n";
    if(tag==="pre") {
      // A fence cannot contain clickable references without changing code text.
      // Preserve the static source tree when the code itself has references.
      if(all(node).some(n=>(n.tagName==="a"&&safeUrl(attr(n,"href")))||(n.tagName==="img"&&safeUrl(attr(n,"src")))))return "\n\n"+this.keep(this.safeHtml(node,true))+"\n\n";
      const code=text(node),codeElement=all(node).find(n=>n.tagName==="code");
      const language=((attr(node,"class")??"")+" "+(codeElement?attr(codeElement,"class")??"":"")).match(/(?:language|lang)-([A-Za-z0-9_+-]+)/)?.[1]??"";
      const fence="`".repeat(Math.max(3,...[...code.matchAll(/`+/g)].map(m=>m[0].length+1)));
      const descendantAnchors=all(node).map(n=>this.anchor(n)).join("");
      return "\n\n"+anchor+descendantAnchors+(anchor||descendantAnchors?"\n":"")+this.keep(fence+language+"\n"+code+"\n"+fence)+"\n\n";
    }
    if(tag==="code") {
      const code=text(node),ticks="`".repeat(Math.max(1,...[...code.matchAll(/`+/g)].map(m=>m[0].length+1)));
      const pad=/^`|`$/.test(code)||(/^ .* $/.test(code)&&code.trim())?" ":"";
      return anchor+this.keep(ticks+pad+code+pad+ticks);
    }
    if(tag==="a") {const href=safeUrl(attr(node,"href")),label=this.inline(node);if(!href)return anchor+label;this.links.add(href);return anchor+`[${label||mdText(href)}](${destination(href)})`;}
    if(tag==="img") {const src=safeUrl(attr(node,"src"));if(!src||src.includes("/Images-CSS-Skin/"))return anchor;this.images.add(src);return anchor+`![${mdText(attr(node,"alt")??"")}](${destination(src)})`;}
    if(tag==="br")return anchor+"\n";
    if(tag==="hr")return "\n\n"+anchor+"---\n\n";
    if(tag==="ul"||tag==="ol") {
      // Restoring a masked multiline code/table inside list indentation would
      // indent only its first line. Static HTML keeps the whole block nested.
      if(all(node).some(n=>["pre","table"].includes(n.tagName)))return "\n\n"+this.keep(this.safeHtml(node,true))+"\n\n";
      return anchor+this.list(node);
    }
    if(tag==="blockquote")return "\n\n"+anchor+this.body(node).trim().split("\n").map(line=>"> "+line).join("\n")+"\n\n";
    if(["strong","b","em","i","del","s"].includes(tag)){const marker=["strong","b"].includes(tag)?"**":["em","i"].includes(tag)?"*":"~~";return anchor+marker+this.inline(node)+marker;}
    const value=anchor+this.body(node);
    return BLOCK.has(tag)?"\n\n"+value+"\n\n":value;
  }
  finish(node:Node):string {
    const normalized=this.render(node).split("\n").map(line=>line.trimEnd()).join("\n").replace(/\n{3,}/g,"\n\n").trim();
    return this.restore(normalized);
  }
}

export function renderProductHtml(source:string):DomMarkdown {
  const document=parse(source),renderer=new Renderer(source),elements=all(document);
  const stableIdentifiers:Record<string,string>={};
  for(const node of elements.filter(n=>n.tagName==="meta")){
    const name=attr(node,"name")?.toLowerCase(),value=attr(node,"content");
    if(name&&value&&["ait_topic_id","microsoft.help.id","microsoft.help.f1","title","product"].includes(name))stableIdentifiers[name]=value.trim();
  }
  const markdown=renderer.finish(document),heading=elements.find(n=>/^h[1-6]$/.test(n.tagName)||(attr(n,"class")??"").split(/\s+/).includes("i-page-title-text"));
  return {markdown,title:heading?compact(text(heading)):stableIdentifiers.title,anchors:[...renderer.anchors],links:[...renderer.links],images:[...renderer.images],stableIdentifiers,
    sourceFormat:elements.some(n=>/i-page-title-text|i-section-heading/.test(attr(n,"class")??""))?"innovasys-html":/MadCap|mc-.*|data-mc/i.test(source)?"madcap-html":"html"};
}

/** Canonical complex tables and linked pre blocks retain static HTML. Mask
 * them before Markdown detection, sanitizing again instead of
 * trusting a caller-supplied marker. Source offsets preserve surrounding MD. */
export function protectCanonicalHtmlTables(source:string,keep:(value:string)=>string):string {
  if(!/data-relay-structure="(?:table|pre|ul|ol)"/.test(source))return source;
  const fragment=parseFragment(source,{sourceCodeLocationInfo:true}),ranges:Array<{start:number;end:number;value:string}>=[];
  const visit=(node:Node)=>{
    if(element(node)&&["table","pre","ul","ol"].includes(node.tagName)&&attr(node,"data-relay-structure")===node.tagName&&node.sourceCodeLocation){
      const location=node.sourceCodeLocation;
      ranges.push({start:location.startOffset,end:location.endOffset,value:new Renderer(source).safeHtml(node,true)});return;
    }
    children(node).forEach(visit);
  };
  visit(fragment);
  for(const range of ranges.sort((a,b)=>b.start-a.start))source=source.slice(0,range.start)+keep(range.value)+source.slice(range.end);
  return source;
}
