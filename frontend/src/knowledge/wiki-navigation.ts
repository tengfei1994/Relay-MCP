/** A selection epoch also invalidates A → B → A responses from the first A. */
export function createWikiNavigation() {
  let selected: string | undefined, epoch=0;
  return {
    capture(key:string) {
      if (key!==selected) {selected=key;epoch++;}
      const captured=epoch;
      return {
        isCurrent:()=>epoch===captured,
        commit(update:()=>void) {if(epoch===captured) update();},
      };
    },
  };
}
