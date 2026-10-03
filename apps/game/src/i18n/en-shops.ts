/**
 * English strings of lane NPC-C NPC dialog, shops, storage, cast bar (docs/SHOPS.md). Spread into en.ts (docs/WAVE_PLAN.md decision 39):
 * only that lane edits this file. en.ts keys win over a duplicate here.
 */
export const enShops = {
  // ---- NPC dialog (docs/SHOPS.md §3.2; option captions follow the retail NPC_CHATTING_WND strings) ----
  'npc.greeting.default': 'Greetings, traveller.',
  'npc.option.shop': 'Trade in the shop.',
  'npc.option.storage': 'Deposit into storage.',
  'npc.option.repair': 'Repair equipment.',
  'npc.option.quest': 'Talk to this person.',
  'npc.option.end': 'End conversation.',
  'npc.noShop': 'This merchant has nothing to sell right now.',
  'npc.noQuest': 'This person has nothing more to tell you.',

  // ---- shop ----
  'shop.title': 'Shop',
  'shop.titleNpc': '{name}',
  'shop.tab.buyback': 'Buy back',
  'shop.gender.male': 'Male',
  'shop.gender.female': 'Female',
  'shop.genderHint': 'Switch between the male and female goods',
  'shop.empty': 'Nothing for sale here.',
  'shop.buybackEmpty': 'Items you sell here can be bought back for the same price.',
  'shop.selectHint': 'Select an item to buy.',
  'shop.price': 'Price: {gold} gold',
  'shop.priceEach': 'Price: {gold} gold each',
  'shop.buybackPrice': 'Buy back for {gold} gold',
  'shop.yourGold': 'Your gold',
  'shop.buy': 'Buy',
  'shop.sell': 'Sell',
  'shop.buyTitle': 'Buy',
  'shop.buyBody': 'How many {name} ({gold} gold each)? Up to {max}.',
  'shop.sellTitle': 'Sell',
  'shop.sellBodyCount': 'How many {name} do you want to sell ({gold} gold each)? Up to {max}.',
  'shop.sellConfirm': 'Sell {name} for {gold} gold?',
  'shop.cantSell': 'That item cannot be sold.',
  'shop.hint': 'Right click or double click: buy  |  Drag a bag item here or right click it in the bag: sell',
  'shop.hintBuy': 'Right click to buy',
  'shop.hintBuyMany': 'Right click to buy (you choose how many)',
  'shop.hintBuyback': 'Right click to buy back',

  // ---- storage (docs/SHOPS.md §5) ----
  'storage.title': 'Storage',
  'storage.titleNpc': 'Storage - {name}',
  'storage.loading': 'Opening the storage...',
  'storage.used': '{used} / {size}',
  'storage.gold': 'Stored gold',
  'storage.bagGold': 'Carried: {gold}',
  'storage.deposit': 'Deposit',
  'storage.withdraw': 'Withdraw',
  'storage.depositTitle': 'Deposit',
  'storage.withdrawTitle': 'Withdraw',
  'storage.countBody': 'How many {name}? Up to {max}.',
  'storage.countBodyFee': 'How many {name}? Up to {max}. Storage fee: {gold} gold each.',
  'storage.goldDepositTitle': 'Deposit gold',
  'storage.goldWithdrawTitle': 'Withdraw gold',
  'storage.goldBody': 'How much gold? Up to {max}.',
  'storage.fee': 'Storage fee: {gold} gold each',
  'storage.cantStore': 'That item cannot be stored.',
  'storage.hint': 'Drag items between the bag and the storage, or right click them  |  Shift: choose how many',
  'storage.hintStored': 'Right click or drag to the bag to withdraw',

  // ---- item cast bar (docs/SHOPS.md §4.3) ----
  'cast.using': '{name}',
  'cast.seconds': '{s} s',
  'cast.stopped': 'Cancelled',
  'cast.cancelled': 'The use of return scroll has been canceled.',

  // ---- ?mock=1 (net/mock/npc.ts) ----
  'mock.npc.storageKeeper': 'The mock merchant also keeps a storage for you (it lasts until the page reloads).',
} satisfies Record<string, string>
