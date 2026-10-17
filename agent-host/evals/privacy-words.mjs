// Word lists for the free-text reliability check in privacy.mjs. A note is kept only when every
// word in it is ordinary: listed here, or used lower case across many records of the same export.
// The list holds function words, common verbs and nouns of office notes, and roofing trade terms;
// it leaves out words that are mostly given names or surnames.

const words = (text) => text.trim().split(/\s+/);

export const BASE_WORDS = new Set(
  words(`
a an the and or but nor so yet if then than that this these those there here where when what which who whom whose why how
all any both each either neither every few many much more most less least other others another such same own only just also
too very quite rather really almost already still even ever never always often sometimes usually soon now again once twice
not no yes ok okay maybe perhaps please thanks thank sorry hi hello hey dear regards cheers sincerely etc re per vs via
i me my mine myself we us our ours ourselves you your yours yourself he him his himself she her hers herself it its itself
they them their theirs themselves one ones someone somebody anyone anybody everyone everybody nobody none something
anything everything nothing
about above across after against along among around as at before behind below beneath beside besides between beyond by
down during except for from in inside into like near nearby of off on onto out outside over past since through throughout
till to toward towards under underneath until up upon with within without
am is are was were be been being have has had having do does did done doing will would shall should can could may might
must ought won't wont can't cant cannot don't dont doesn't doesnt didn't didnt isn't isnt wasn't wasnt aren't arent
weren't werent haven't havent hasn't hasnt hadn't hadnt wouldn't wouldnt couldn't couldnt shouldn't shouldnt i'm im i've
ive i'll i'd you're youre you've you'll he's hes she's shes it's we're we've we'll they're theyre they've they'll that's
thats there's theres what's whats let's lets
ask asked asking asks call called calling calls came come comes coming check checked checking checks confirm confirmed
confirming confirmation book booked booking bring brings brought buy bought buying cancel cancelled canceled cancelling
cancellation change changed changes changing clean cleaned cleaning close closed closing collect collected complete
completed completing completion contact contacted continue continued cover covered covering covers cut cuts cutting
decide decided deliver delivered delivering discuss discussed discussing drop dropped dropping drove email emailed
emailing emails expect expected explain explained finish finished finishing fix fixed fixing follow followed following
get gets getting got gotten give given gives giving go goes going gone went happen happened happening hear heard help
helped helping hold holding install installed installing installs keep keeping kept know knew known knows leave leaves
leaving left let look looked looking looks lose losing make makes making made meet meeting met mention mentioned miss
missed move moved moving need needed needing needs note noted noting order ordered ordering orders pay paid paying pick
picked picking place placed plan planned planning plans prefer preferred prefers prepare prepared provide provided
providing put puts putting quote quoted quoting reach reached read ready receive received receiving remove removed
removing repair repaired repairing replace replaced replacing reply replied request requested requesting requests return
returned returning review reviewed run running runs said say says saying schedule scheduled scheduling see seeing seen
send sending sends sent set sets setting show showed showing shown sign signed signing speak spoke speaking spoken start
started starting starts stop stopped stopping take taken takes taking talk talked talking tell telling told text texted
texting think thinking thought try tried trying turn turned understand understood update updated updating updates use
used uses using visit visited visiting wait waited waiting walk walked want wanted wanting wants wish work worked working
works write writes writing wrote written measure measured measuring measures inspect inspected inspecting approve
approved approval decline declined accept accepted reject rejected submit submitted share shared attach attached upload
uploaded refer referred referral referrals reschedule rescheduled postpone postponed arrive arrived arriving leave
answer answered answering appreciate appreciated agree agreed arrange arranged assess assessed believe charge charged
choose chose compare compared consider considered decide estimate estimated figure figured find found finds fit fitted
handle handled hire hired include included includes including inform informed interested keep lift lifted load loaded
match matched mean means meant notice noticed offer offered open opened opening own owned prep prepped price priced
promise promised push pushed rain rained reply rent rented repaint replaced reroofed resend reset respond responded
save saved seal sealed sell selling sold settle settled ship shipped shut sit sits slide slid stay stayed store stored
suggest suggested supply supplied tape taped test tested touch touched track tracked train trained transfer try unload
unloaded wash washed wonder wondering worry worried wrap wrapped
time times day days daily week weeks weekly month months monthly year years yearly hour hours hourly hr hrs minute
minutes min mins today tomorrow yesterday tonight morning mornings afternoon afternoons evening evenings night nights
noon midnight weekend weekends weekday weekdays date dates moment while asap
money price prices pricing cost costs budget amount amounts total totals balance deposit deposits payment payments
invoice invoices receipt receipts cheque cheques check cash card credit debit financing finance finances tax taxes gst
pst rate rates fee fees charge charges dollar dollars cents discount discounts quote quotes estimate estimates
estimator estimators proposal proposals contract contracts warranty warranties guarantee permit permits claim claims
insurance insurer insurers adjuster adjusters deductible policy
house houses home homes building buildings property properties garage garages shed sheds barn barns shop shops office
offices business businesses commercial residential condo condos townhouse townhouses duplex acreage acreages farm farms
cabin cabins church school warehouse warehouses unit units complex apartment apartments basement bungalow bi-level
two-storey storey storeys story stories level levels floor floors addition additions porch porches patio carport deck
decks balcony
roof roofs roofing rooftop shingle shingles shingled asphalt metal steel aluminum aluminium tin copper zinc cedar shake
shakes tile tiles slate rubber membrane membranes epdm tpo sbs torch torch-on modified bitumen tar gravel flat low slope
slopes sloped pitch pitched pitches steep siding soffit soffits fascia fascias gutter gutters eaves eavestrough
eavestroughs downspout downspouts flashing flashings drip edge edges ridge ridges cap caps capping valley valleys hip hips
rake rakes gable gables dormer dormers chimney chimneys skylight skylights vent vents venting ventilation exhaust intake
attic attics insulation decking sheathing plywood osb underlayment synthetic felt ice water shield starter strip strips
nails nail screws screw fasteners fastener closures closure trim trims panel panels sheet sheets seam seams standing
exposed concealed corrugated ribbed gauge ga colour color colours colors coloured finish matte gloss painted snow guards
guard boot boots pipe pipes stack stacks drain drains scupper scuppers parapet parapets wall walls window windows door
doors frame frames board boards fascia-board wrap housewrap caulking caulk sealant butyl foam vapour vapor barrier
barriers stucco vinyl hardie fibre fiber cement brick stone wood wooden composite rafter rafters truss trusses joist
joists beam beams overhang overhangs eave
squares square sq ft feet foot sqft lf linear meter meters metre metres inch inches mm cm bundle bundles roll rolls box
boxes pail pails tube tubes bag bags piece pieces pcs ea each pallet pallets load loads truck trucks trailer trailers
layer layers tear tearoff tear-off reroof re-roof overlay new old older newer existing original current previous
previously used
leak leaks leaking leaky leaked drip drips dripping damage damaged damages rot rotten rotted mold mould moisture wet dry
hail storm storms wind winds windy weather rain rainy snow snowy icy dam dams frost freeze freezing cold heat hot sun sunny
temperature temperatures forecast
customer customers client clients homeowner homeowners owner owners tenant tenants landlord landlords manager managers
management board neighbour neighbours neighbor neighbors husband wife son daughter family kids partner spouse mom dad
mother father brother sister friend friends people person persons someone's caller callers
crew crews foreman foremen installer installers labour labor labourer labourers laborer laborers worker workers team
teams staff sales rep reps salesperson subcontractor subcontractors sub subs supplier suppliers vendor vendors
dispatcher scheduler admin office estimator inspector inspectors engineer engineers contractor contractors builder
builders company companies competitor competitors
lead leads inquiry inquiries enquiry enquiries website websites web online form forms ad ads advert advertisement google
facebook instagram kijiji homestars yelp houzz sign signs flyer flyers radio mail mailer email phone phones text texts
message messages voicemail vm call voice
job jobs project projects site sites work scope material materials supply supplies delivery deliveries order dumpster
dumpsters bin bins disposal cleanup ladder ladders scaffold scaffolding harness safety access driveway yard backyard
lawn fence fences tree trees
area areas side sides front back rear top bottom left right north south east west upper lower middle center centre
corner corners section sections part parts portion whole half full entire rest
size sizes small large big bigger biggest smaller smallest medium high higher highest low lower lowest long longer short
shorter wide wider narrow tall thick thin heavy light
good great fine bad poor worse worst best better nice fair excellent decent rough solid loose tight broken missing
cracked bent lifted curled curling buckled sagging blown torn worn clear clean dirty safe unsafe possible impossible
likely unlikely sure unsure happy unhappy pleased upset busy free available unavailable able unable
quick quickly slow slowly urgent urgently emergency priority later early late latest next last first second third final
finally recent recently right wrong ready
number numbers one two three four five six seven eight nine ten eleven twelve fifteen twenty thirty forty fifty sixty
seventy eighty ninety hundred thousand million few several couple dozen half quarter
question questions answer answers issue issues problem problems concern concerns reason reasons option options choice
choices preference preferences interest info information detail details note notes comment comments idea ideas plan
appointment appointments meeting meetings visit visits walkthrough walk-through follow-up followup callback call-back
reminder reminders conversation conversations discussion request requests response responses reply
spring summer fall autumn winter season seasons seasonal year-round
monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thur thurs fri sat sun
january february march april may june july august september october november december jan feb mar apr jun jul aug sep
sept oct nov dec
black white grey gray charcoal brown red blue green tan beige bronze copper silver gold sandstone cream ivory dark light
galvalume galvanized galvanised galvalum vicwest westman kenroc gaf iko certainteed malarkey tyvek sika soprema
duro-last ideal bp emco dynasty cambridge timberline landmark duration
alberta canada city town county rural acreage country province street road avenue address addresses postal code
lot block plan legal land
will would wouldn't via also
replacement replacements installation installations kitchen bathroom bedroom room rooms ceiling ceilings stairs
interior exterior inside outside renovation renovations upgrade upgrades
`),
);

// Upper-case words that are not names: units, provinces, quadrants, trade and office acronyms.
export const ACRONYMS = new Set(
  words(`
AB BC SK MB ON QC NS NB PE NL YT NT NU NW NE SW SE N S E W AM PM VM LVM LM ASAP ETA TBD TBC FYI NA GST PST HST QB CRM JN
GHL HVAC EPDM TPO SBS PVC OSB GAF IKO BP OC SF SQ FT LF MM CM EA PCS UV DIY PDF ID USA US CAD CDN OK PO RR DM SMS CC RE FW
FWD WO
`),
);

// Listed words that are also common given names; capitalised, they count as names.
export const NAME_HOMONYMS = new Set(
  words(`
will may mark bill april june august summer autumn frank pat ray rob guy chase dawn hope joy art dean drew sandy rich rose
faith hunter mason carter cooper glen dale max don grant jack ivy amber holly crystal ruby
`),
);

// Listed words that are also common surnames. Capitalised mid-sentence, or starting a sentence
// before a verb a person does ("Price confirmed", "White called"), they count as names.
export const SURNAME_HOMONYMS = new Set(
  words(`
green white brown black grey gray price wood stone hall wall lane young long little hill hills king fields banks
booth marsh frost
`),
);

// What a person does or is: after a name-like word, these make it a name ("Green said", "Wood is
// coming").
export const PERSON_VERBS = new Set(
  words(`
called calling calls phoned texted emailed messaged said says asked asks confirmed replied responded agreed declined
approved accepted wants wanted came mentioned told tells from here left signed paid booked requested dropped picked
`),
);
export const PERSON_AUXILIARIES = new Set(words("is was will would has had can could"));
export const PERSON_ACTIONS = new Set(
  words("call calling text texting email emailing come coming be here home away back out pay paying send sending sign signing confirm going gone available"),
);

// Verbs only a person does: after any capitalised word that is not a role or a pronoun, they make
// it a name ("Gold called back", "Tan wants a quote").
export const STRONG_PERSON_VERBS = new Set(
  words("called calling phoned texted emailed messaged said says asked asks replied responded agreed declined mentioned told tells wants wanted"),
);
// Who may do those things without being a name: pronouns, roles, and suppliers.
export const PERSON_SUBJECTS = new Set(
  words(`
i we they he she you it someone somebody nobody everyone everybody customer customers client clients homeowner
homeowners owner owners tenant tenants landlord landlords manager managers office crew crews foreman installer
installers supplier suppliers vendor vendors adjuster adjusters insurance insurer insurers company companies rep reps
sales salesperson inspector inspectors contractor contractors builder builders team staff estimator dispatcher
wife husband son daughter mom dad mother father brother sister neighbour neighbours neighbor neighbors family partner
spouse caller callers lead leads
`),
);

// Platforms and suppliers written capitalised anywhere in a sentence.
export const BRAND_WORDS = new Set(
  words(`
galvalume vicwest westman kenroc gaf iko certainteed malarkey tyvek sika soprema duro-last emco dynasty cambridge
timberline landmark google facebook instagram kijiji homestars yelp houzz
`),
);

// Capitalised words that are ordinary in the middle of a sentence; any other capitalised word
// there counts as a name.
export const MID_SENTENCE_WORDS = new Set([
  ...BRAND_WORDS,
  ...words(`
i i'm i've i'll i'd alberta canada monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thur
thurs fri sat sun january february march july september october november december jan feb mar apr jun jul aug sep
sept oct nov dec
`),
]);

// Month and season names that are also given names: capitalised, they count as dates only next
// to a date word or a number ("in June", "June 5").
export const DATE_HOMONYMS = new Set(words("april may june august summer autumn"));
export const DATE_CUES = new Set(words("in by until till before after since early late mid of this next last during end"));
