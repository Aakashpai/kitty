// First match wins; whole words only, so "parking" is not a park and "Cola" is not Ola.
const GUESSES = [
  ['Shopping', "shop|shopping|mall|clothes|clothing|shoes?|iphone|airtag|apple store|electronics|souvenirs?|uniqlo|zara|h&m|ikea|amazon|myntra|flipkart|ck|charles ?& ?keith"],
  ['Groceries', 'groceries|grocery|supermarket|fairprice|cold storage|big ?basket|blinkit|zepto|instamart|dmart'],
  ['Drinks', 'drinks?|bar|beers?|wine|cocktails?|pub|brewery|toddy'],
  ['Food', "food|lunch|dinner|breakfast|brunch|meals?|restaurant|cafe|coffee|kopi|tea|sushi|pizza|burgers?|snacks?|bbq|hawker|7-?eleven|starbucks|mcdonald'?s|kfc|desserts?|ice ?cream|bakery|noodles?|ramen|biryani|swiggy|zomato|dim ?sum|laksa|satay|chicken rice|juice|tacos?|f&b|bistro|grill|eatery|canteen|boba|bubble tea|shake shack"],
  ['Travel', 'flights?|airlines?|airport|taxi|cab|uber|grab|ola|rapido|train|metro|mrt|bus|ferry|fuel|petrol|diesel|toll|parking|transport|visa|ez-?link|touch ?n ?go|travel|car rental|rental car|car hire'],
  ['Stay', 'hotel|hostel|airbnb|resort|stay|homestay|lodge|check-?in'],
  ['Activities', 'tickets?|tours?|museum|zoo|shows?|movies?|cinema|entry|universal|sentosa|aquarium|spa|massage|snorkel(ling)?|diving|trek|activity|activities|luge|rides?|theme park|water ?park|park'],
  ['Health', 'pharmacy|medicines?|meds|doctor|hospital|clinic|chemist|guardian|watsons'],
  ['Bills', 'bills?|rent|electricity|wifi|internet|recharge|sim|subscription|insurance|netflix|spotify'],
  ['Gifts', 'gifts?|presents?|birthday'],
].map(([c, words]) => [c, new RegExp(`\\b(${words})\\b`, 'i')] as const);
/** Best-guess category from a description ("Dinner at Lau Pa Sat" -> Food), or null when nothing fits. */
export const guessCategory = (description: string): string | null => GUESSES.find(([, re]) => re.test(description))?.[0] ?? null;
