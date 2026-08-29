const { withDifficulty } = require("./difficulty");

// Countries
const countries = [
  "Egypt", "Saudi Arabia", "United Arab Emirates", "Kuwait", "Qatar", "Bahrain", "Oman", "Jordan",
  "Lebanon", "Syria", "Iraq", "Yemen", "Palestine", "Libya", "Tunisia", "Algeria",
  "Morocco", "Sudan", "Mauritania", "Somalia", "Turkey", "Iran", "Pakistan", "Afghanistan",
  "India", "China", "Japan", "South Korea", "North Korea", "Vietnam", "Thailand", "Indonesia",
  "Malaysia", "Philippines", "Singapore", "Bangladesh", "Sri Lanka", "Nepal", "Russia", "Ukraine",
  "Poland", "Germany", "France", "Italy", "Spain", "Portugal", "United Kingdom", "Ireland",
  "Netherlands", "Belgium", "Switzerland", "Austria", "Sweden", "Norway", "Denmark", "Finland",
  "Greece", "Romania", "Bulgaria", "Serbia", "Croatia", "Hungary", "Czech Republic", "Slovakia",
  "United States", "Canada", "Mexico", "Brazil", "Argentina", "Chile", "Peru", "Colombia",
  "Venezuela", "Cuba", "Australia", "New Zealand", "South Africa", "Nigeria", "Kenya", "Ethiopia",
  "Ghana",
];

// Food & Kitchen
const food = [
  "Apple", "Banana", "Orange", "Grapes", "Strawberry", "Watermelon", "Cantaloupe", "Mango",
  "Pineapple", "Kiwi", "Peach", "Apricot", "Pear", "Pomegranate", "Fig", "Date",
  "Guava", "Lemon", "Tangerine", "Cherry", "Tomato", "Cucumber", "Potato", "Onion",
  "Garlic", "Carrot", "Pepper", "Eggplant", "Zucchini", "Lettuce", "Spinach", "Okra",
  "Green Beans", "Peas", "Corn", "Rice", "Lentils", "Chickpeas", "Fava Beans", "Bread",
  "Cheese", "Butter", "Egg", "Milk", "Honey", "Sugar", "Salt", "Oil",
  "Flour", "Pasta", "Pizza", "Burger", "Shawarma", "Kebab", "Falafel", "Sushi",
  "Taco", "Sandwich", "Pancake", "Waffle", "Ice Cream", "Chocolate", "Cake", "Cookie",
  "Tea", "Coffee", "Juice", "Soda", "Salad", "Soup", "Frying Pan", "Oven",
  "Knife", "Spoon", "Fork", "Plate", "Cup", "Refrigerator", "Dishwasher", "Blender",
  "Kettle", "Toaster",
];

// Movies (Hollywood / English)
const movies = [
  "Titanic", "Avatar", "Inception", "The Matrix", "Jurassic Park", "The Lion King", "Frozen", "Toy Story",
  "Finding Nemo", "Shrek", "The Avengers", "Iron Man", "Spider-Man", "Batman", "Superman", "Wonder Woman",
  "Black Panther", "The Dark Knight", "Star Wars", "The Godfather", "Forrest Gump", "The Shawshank Redemption", "Pulp Fiction", "Fight Club",
  "Gladiator", "Braveheart", "Rocky", "Home Alone", "Aladdin", "The Little Mermaid", "Beauty and the Beast", "Cinderella",
  "Harry Potter", "The Lord of the Rings", "The Hobbit", "Pirates of the Caribbean", "Indiana Jones", "Back to the Future", "E.T.", "Jaws",
  "King Kong", "Godzilla", "Transformers", "Fast and Furious", "Mission Impossible", "James Bond", "John Wick", "Mad Max",
  "The Terminator", "Alien", "Predator", "Die Hard", "Rush Hour", "Men in Black", "Ghostbusters", "The Sixth Sense",
  "Signs", "Split", "Get Out", "A Quiet Place", "La La Land", "Whiplash", "The Social Network", "The Wolf of Wall Street",
  "Moneyball", "Interstellar", "Dunkirk", "Joker", "Parasite", "Oppenheimer", "Barbie", "Deadpool",
  "Guardians of the Galaxy", "Doctor Strange", "Thor", "Captain America", "Ant-Man", "The Incredibles", "Up", "Coco",
];

// Objects
const objects = [
  "Door", "Window", "Chair", "Table", "Bed", "Closet", "Mirror", "Clock",
  "Phone", "Computer", "Television", "Remote Control", "Key", "Lock", "Umbrella", "Bag",
  "Wallet", "Glasses", "Pen", "Book", "Notebook", "Ruler", "Scissors", "Pin",
  "Needle", "Thread", "Nail", "Hammer", "Saw", "Screwdriver", "Ladder", "Bucket",
  "Broom", "Mop", "Soap", "Shampoo", "Toothbrush", "Toothpaste", "Towel", "Blanket",
  "Pillow", "Carpet", "Curtain", "Lamp", "Fan", "Air Conditioner", "Heater", "Washing Machine",
  "Refrigerator", "Oven", "Microwave", "Blender", "Juicer", "Kettle", "Tray", "Plate",
  "Cup", "Spoon", "Fork", "Knife", "Pot", "Pan", "Car", "Bicycle",
  "Train", "Airplane", "Ship", "Boat", "Wheel", "Engine", "Battery", "Charger",
  "Wire", "Light Switch", "Bell", "Box", "Backpack", "Suitcase", "Passport", "Coin",
  "Receipt", "Envelope",
];

// Animals
const animals = [
  "Cat", "Dog", "Lion", "Tiger", "Cheetah", "Wolf", "Fox", "Bear",
  "Elephant", "Giraffe", "Zebra", "Hippopotamus", "Rhinoceros", "Deer", "Rabbit", "Squirrel",
  "Hedgehog", "Bat", "Monkey", "Gorilla", "Chimpanzee", "Kangaroo", "Koala", "Penguin",
  "Ostrich", "Eagle", "Falcon", "Owl", "Parrot", "Swan", "Duck", "Goose",
  "Chicken", "Rooster", "Pigeon", "Sparrow", "Swallow", "Crow", "Peacock", "Horse",
  "Donkey", "Mule", "Cow", "Buffalo", "Sheep", "Goat", "Camel", "Pig",
  "Mouse", "Hare", "Snake", "Crocodile", "Turtle", "Lizard", "Frog", "Fish",
  "Shark", "Whale", "Dolphin", "Octopus", "Jellyfish", "Starfish", "Crab", "Lobster",
  "Bee", "Butterfly", "Ant", "Spider", "Cockroach", "Mosquito", "Fly", "Dragonfly",
  "Worm", "Snail", "Sea Urchin", "Seal", "Sea Lion", "Emperor Penguin", "Jackal", "Hyena",
];

// Names (celebrities / generally famous figures)
const names = [
  "Albert Einstein", "Isaac Newton", "Thomas Edison", "Leonardo da Vinci", "Pablo Picasso", "William Shakespeare", "Charlie Chaplin", "Walt Disney",
  "Steve Jobs", "Bill Gates", "Mark Zuckerberg", "Elon Musk", "Napoleon Bonaparte", "Mahatma Gandhi", "Martin Luther King", "Nelson Mandela",
  "Marilyn Monroe", "Elvis Presley", "Michael Jackson", "Madonna", "Beyonce", "Lady Gaga", "Tom Cruise", "Leonardo DiCaprio",
  "Brad Pitt", "Angelina Jolie", "Johnny Depp", "Will Smith", "Dwayne Johnson", "Robert Downey Jr", "Lionel Messi", "Cristiano Ronaldo",
  "Mohamed Salah", "Michael Jordan", "Muhammad Ali", "Serena Williams", "Usain Bolt", "Taylor Swift", "Ariana Grande", "Justin Bieber",
  "Rihanna", "Ed Sheeran", "Adele", "Bruno Mars", "Katy Perry", "Selena Gomez", "Emma Watson", "Scarlett Johansson",
  "Chris Hemsworth", "Chris Evans", "Robert Pattinson", "Keanu Reeves", "Morgan Freeman", "Denzel Washington", "Samuel L Jackson", "Jack Nicholson",
  "Al Pacino", "Robert De Niro", "Meryl Streep", "Julia Roberts", "Sandra Bullock", "Jennifer Lawrence", "Tom Hanks", "George Clooney",
  "Matt Damon", "Ben Affleck", "Hugh Jackman", "Ryan Reynolds", "Chris Pratt", "Zendaya", "Timothee Chalamet", "Margot Robbie",
  "Anne Hathaway", "Natalie Portman", "Charlize Theron", "Nicole Kidman", "Oprah Winfrey", "Ellen DeGeneres", "Barack Obama", "Queen Elizabeth II",
];

module.exports = {
  countries: withDifficulty(countries),
  food: withDifficulty(food, 2),
  movies: withDifficulty(movies, 4),
  objects: withDifficulty(objects, 1),
  animals: withDifficulty(animals, 3),
  names: withDifficulty(names, 5),
};
