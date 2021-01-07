'use strict'

module.exports = ECS
var DataStore = require('./dataStore')



/*!
 * ent-comp: a light, *fast* Entity Component System in JS
 * @url      github.com/andyhall/ent-comp
 * @author   Andy Hall <andy@fenomas.com>
 * @license  MIT
*/



/**
 * Constructor for a new entity-component-system manager.
 * 
 * ```js
 * var ECS = require('ent-comp')
 * var ecs = new ECS()
 * ```
 * @class
 * @constructor
 * @exports ECS
 * @typicalname ecs
*/

function ECS() {
	var self = this

	/** 
	 * Hash of component definitions. Also aliased to `comps`.
	 * 
	 * ```js
	 * var comp = { name: 'foo' }
	 * ecs.createComponent(comp)
	 * ecs.components['foo'] === comp // true
	 * ecs.comps['foo']               // same
	 * ```
	*/
	this.components = {}
	this.comps = this.components



	/*
	 * 
	 * 		internal properties:
	 * 
	*/

	var components = this.components

	// counter for entity IDs
	var UID = 1

	// Storage for all component state data:
	// storage['component-name'] = { hash:{}, list:[] }
	var storage = {}

	// flat arrays of names of components with systems
	var systems = []
	var renderSystems = []

	// queues for deferred operations
	var deferredEntityRemovals = []
	var deferredCompRemovals = []
	var deferredMultiCompRemovals = []


	// add references to internals, for debugging/hacking
	this._storage = storage
	this._systems = systems
	this._renderSystems = renderSystems


	/*
	 * 
	 * 
	 * 				Public API
	 * 
	 * 
	*/




	/**
	 * Creates a new entity id (currently just an incrementing integer).
	 * 
	 * Optionally takes a list of component names to add to the entity (with default state data).
	 * 
	 * Optionally takes a customID (instead of just an incrementing integer).
	 *
	 * ```js
	 * var id1 = ecs.createEntity()
	 * var id2 = ecs.createEntity([ 'some-component', 'other-component' ])
	 * var myId = var id2 = ecs.createEntity(null, "myId")
	 * ```
	*/
	this.createEntity = function (compList, customId) {
		var id = customId || UID++
		if (compList && compList.length) {
			compList.forEach(compName => self.addComponent(id, compName))
		}
		return id
	}



	/**
	 * Deletes an entity, which in practice just means removing all its components.
	 * By default the actual removal is deferred (since entities often
	 * delete themselves from their system function, etc).
	 * Pass a truthy second parameter to force immediate removal.
	 * 
	 * ```js
	 * ecs.deleteEntity(id)
	 * ecs.deleteEntity(id2, true) // deletes immediately
	 * ```
	*/
	this.deleteEntity = function (entID, immediately) {
		if (immediately) {
			deleteEntityNow(entID)
		} else {
			deferredEntityRemovals.push(entID)
			makeDeferralTimeout()
		}
		return self
	}







	/**
	 * Creates a new component from a definition object. 
	 * The definition must have a `name`; all other properties are optional.
	 * 
	 * Returns the component name, to make it easy to grab when the component
	 * is being `require`d from a module.
	 * 
	 * ```js
	 * var comp = {
	 * 	 name: 'some-unique-string',
	 * 	 state: {},
	 * 	 order: 99,
	 * 	 onAdd:        function(id, state){ },
	 * 	 onRemove:     function(id, state){ },
	 * 	 system:       function(dt, states){ },
	 * 	 renderSystem: function(dt, states){ },
	 * 	 multi: false,
	 * }
	 * 
	 * var name = ecs.createComponent( comp )
	 * // name == 'some-unique-string'
	 * ```
	 * 
	 * Note the `multi` flag - for components where this is true, a given 
	 * entity can have multiple state objects for that component.
	 * For multi-components, APIs that would normally return a state object 
	 * (like `getState`) will instead return an array of them.
	*/
	this.createComponent = function (compDefn) {
		if (!compDefn) throw 'Missing component definition'
		var name = compDefn.name
		if (!name) throw 'Component definition must have a name property.'
		if (typeof name !== 'string') throw 'Component name must be a string.'
		if (name === '') throw 'Component name must be a non-empty string.'
		if (storage[name]) throw `Component ${name} already exists.`

		// rebuild definition object for monomorphism
		var internalDef = {}
		internalDef.name = name
		internalDef.order = isNaN(compDefn.order) ? 99 : compDefn.order
		internalDef.state = compDefn.state || {}
		internalDef.onAdd = compDefn.onAdd || null
		internalDef.onRemove = compDefn.onRemove || null
		internalDef.system = compDefn.system || null
		internalDef.renderSystem = compDefn.renderSystem || null
		internalDef.multi = !!compDefn.multi

		components[name] = internalDef
		storage[name] = DataStore.create()

		if (internalDef.system) {
			systems.push(name)
			systems.sort((a, b) => components[a].order - components[b].order)
		}
		if (internalDef.renderSystem) {
			renderSystems.push(name)
			renderSystems.sort((a, b) => components[a].order - components[b].order)
		}

		return name
	}





	/**
	 * Deletes the component definition with the given name. 
	 * First removes the component from all entities that have it.
	 * 
	 * (This probably shouldn't be called in real-world usage - 
	 * better to define all components when you begin and leave them be - 
	 * but it's here if you need it.)
	 * 
	 * ```js
	 * ecs.deleteComponent( comp.name )
	 * ```
	*/
	this.deleteComponent = function (compName) {
		var data = storage[compName]
		if (!data) throw `Unknown component: ${compName}`

		data.list.forEach(obj => {
			var id = obj.__id || obj[0].__id
			self.removeComponent(id, compName, true)
		})

		var i = systems.indexOf(compName)
		var j = renderSystems.indexOf(compName)
		if (i > -1) systems.splice(i, 1)
		if (j > -1) renderSystems.splice(j, 1)

		delete components[compName]
		delete storage[compName]

		return self
	}




	/**
	 * Adds a component to an entity, optionally initializing the state object.
	 * 
	 * ```js
	 * ecs.createComponent({
	 * 	name: 'foo',
	 * 	state: { val: 0 }
	 * })
	 * ecs.addComponent(id, 'foo', {val:20})
	 * ecs.getState(id, 'foo').val // 20
	 * ```
	*/
	this.addComponent = function (entID, compName, state) {
		var def = components[compName]
		var data = storage[compName]
		if (!data) throw `Unknown component: ${compName}.`

		// if the component is pending removal, remove it so it can be readded
		var pendingRemoval = false
		deferredCompRemovals.forEach(obj => {
			if (obj.id === entID && obj.compName === compName) pendingRemoval = true
		})
		if (pendingRemoval) doDeferredComponentRemovals()

		if (data.hash[entID] && !def.multi) throw `Entity ${entID} already has component: ${compName}.`

		// create new component state object for this entity
		var newState = Object.assign({}, { __id: entID }, def.state, state)

		// just in case passed-in state object had an __id property
		newState.__id = entID

		// add to dataStore - for multi components, may already be present
		if (def.multi) {
			var statesArr = data.hash[entID]
			if (!statesArr) {
				statesArr = []
				DataStore.add(data, entID, statesArr)
			}
			statesArr.push(newState)
		} else {
			DataStore.add(data, entID, newState)
		}

		// call handler and return
		if (def.onAdd) def.onAdd(entID, newState)

		return this
	}



	/**
	 * Checks if an entity has a component.
	 * 
	 * ```js
	 * ecs.addComponent(id, 'comp-name')
	 * ecs.hasComponent(id, 'comp-name') // true
	 * ```
	*/

	this.hasComponent = function (entID, compName) {
		var data = storage[compName]
		if (!data) throw `Unknown component: ${compName}.`
		return (data.hash[entID] !== undefined)
	}





	/**
	 * Removes a component from an entity, deleting any state data.
	 * 
	 * ```js
	 * ecs.removeComponent(id, 'foo', true) // final arg means "immediately"
	 * ecs.hasComponent(id, 'foo')          // false
	 * ecs.removeComponent(id, 'bar')
	 * ecs.hasComponent(id, 'bar')          // true, removal is deferred by default
	 * ```
	*/
	this.removeComponent = function (entID, compName, immediately) {
		var def = components[compName]
		var data = storage[compName]
		if (!data) throw `Unknown component: ${compName}.`

		// if comp isn't present, fail silently for multi or throw otherwise
		if (!data.hash[entID]) {
			if (def.multi) return self
			else throw `Entity ${entID} does not have component: ${compName} to remove.`
		}

		// defer or remove
		if (immediately) {
			removeComponentNow(entID, compName)
		} else {
			deferredCompRemovals.push({
				id: entID,
				compName: compName,
			})
			makeDeferralTimeout()
		}

		return self
	}





	/**
	 * Get the component state for a given entity.
	 * It will automatically have an `__id` property for the entity id.
	 * 
	 * ```js
	 * ecs.createComponent({
	 * 	name: 'foo',
	 * 	state: { val: 0 }
	 * })
	 * ecs.addComponent(id, 'foo')
	 * ecs.getState(id, 'foo').val   // 0
	 * ecs.getState(id, 'foo').__id  // equals id
	 * ```
	*/

	this.getState = function (entID, compName) {
		var data = storage[compName]
		if (!data) throw `Unknown component: ${compName}.`
		return data.hash[entID]
	}




	/**
	 * Get an array of state objects for every entity with the given component. 
	 * Each one will have an `__id` property for the entity id it refers to.
	 * Don't add or remove elements from the returned list!
	 * 
	 * ```js
	 * var arr = ecs.getStatesList('foo')
	 * // returns something shaped like:
	 * //   [ {__id:0, x:1}, 
	 * //     {__id:7, x:2}  ]
	 * ```  
	*/

	ECS.prototype.getStatesList = function (compName) {
		var data = storage[compName]
		if (!data) throw `Unknown component: ${compName}.`
		return data.list
	}




	/**
	 * Returns a `getState`-like accessor bound to a given component name. 
	 * The accessor is faster than `getState`, so you may want to create 
	 * an accessor for any component you'll be accessing a lot.
	 * 
	 * ```js
	 * ecs.createComponent({
	 * 	name: 'size',
	 * 	state: { val: 0 }
	 * })
	 * ecs.addComponent(id, 'size')
	 * var getSize = ecs.getStateAccessor('size')
	 * getSize(id).val // 0
	 * ```  
	*/

	this.getStateAccessor = function (compName) {
		if (!storage[compName]) throw `Unknown component: ${compName}.`
		var hash = storage[compName].hash
		return function (entID) {
			return hash[entID]
		}
	}




	/**
	 * Returns a `hasComponent`-like accessor function bound to a given component name. 
	 * The accessor is much faster than `hasComponent`.
	 * 
	 * ```js
	 * ecs.createComponent({
	 * 	name: 'foo',
	 * })
	 * ecs.addComponent(id, 'foo')
	 * var hasFoo = ecs.getComponentAccessor('foo')
	 * hasFoo(id) // true
	 * ```  
	*/

	this.getComponentAccessor = function (compName) {
		if (!storage[compName]) throw `Unknown component: ${compName}.`
		var hash = storage[compName].hash
		return function (entID) {
			return (hash[entID] !== undefined) // TODO
		}
	}





	/**
	 * Tells the ECS that a game tick has occurred, causing component 
	 * `system` functions to get called.
	 * 
	 * The optional parameter simply gets passed to the system functions. 
	 * It's meant to be a timestep, but can be used (or not used) as you like.    
	 * 
	 * If components have an `order` property, they'll get called in that order
	 * (lowest to highest). Component order defaults to `99`.
	 * ```js
	 * ecs.createComponent({
	 * 	name: foo,
	 * 	order: 1,
	 * 	system: function(dt, states) {
	 * 		// states is the same array you'd get from #getStatesList()
	 * 		states.forEach(state => {
	 * 			console.log('Entity ID: ', state.__id)
	 * 		})
	 * 	}
	 * })
	 * ecs.tick(30) // triggers log statements
	 * ```
	*/

	this.tick = function (dt) {
		runAllDeferredRemovals()
		systems.forEach(compName => {
			var list = storage[compName].list
			var comp = components[compName]
			comp.system(dt, list)
		})
		runAllDeferredRemovals()
		return self
	}



	/**
	 * Functions exactly like `tick`, but calls `renderSystem` functions.
	 * this effectively gives you a second set of systems that are 
	 * called with separate timing, in case you want to 
	 * [tick and render in separate loops](http://gafferongames.com/game-physics/fix-your-timestep/)
	 * (which you should!).
	 * 
	 * ```js
	 * ecs.createComponent({
	 * 	name: foo,
	 * 	order: 5,
	 * 	renderSystem: function(dt, states) {
	 * 		// states is the same array you'd get from #getStatesList()
	 * 	}
	 * })
	 * ecs.render(1000/60)
	 * ```
	*/

	this.render = function (dt) {
		runAllDeferredRemovals()
		renderSystems.forEach(compName => {
			var list = storage[compName].list
			var comp = components[compName]
			comp.renderSystem(dt, list)
		})
		runAllDeferredRemovals()
		return self
	}




	/**
	 * Removes a particular state instance of a multi-component.
	 * Pass a final truthy argument to make this happen synchronously - 
	 * but be careful, that will splice an element out of the multi-component array,
	 * changing the indexes of subsequent elements.
	 * 
	 * ```js
	 * ecs.getState(id, 'foo')   // [ state1, state2, state3 ]
	 * ecs.removeMultiComponent(id, 'foo', 1, true)  // true means: immediately
	 * ecs.getState(id, 'foo')   // [ state1, state3 ]
	 * ```
	 */
	this.removeMultiComponent = function (entID, compName, index, immediately) {
		var def = components[compName]
		var data = storage[compName]
		if (!data) throw `Unknown component: ${compName}.`
		if (!def.multi) throw 'removeMultiComponent called on non-multi component'

		// throw if comp isn't present, or multicomp isn't present at index
		var statesArr = data.hash[entID]
		if (!statesArr || !statesArr[index]) {
			throw `Multicomponent ${compName} instance not found at index ${index}`
		}

		// index removals by object, in case indexes change later
		var stateToRemove = statesArr[index]
		if (immediately) {
			removeMultiCompNow(entID, compName, stateToRemove)
		} else {
			deferredMultiCompRemovals.push({
				id: entID,
				compName: compName,
				state: stateToRemove,
			})
		}

		return self
	}








	/*
	 * 
	 * 
	 *		internal implementation of various delete operations
	 * 
	 * 
	*/


	// delete entity - meaning simply remove all its components
	function deleteEntityNow(entID) {
		// For now loop over all components
		// Could speed this up by keeping a hash of components held by each entity?
		Object.keys(storage).forEach(compName => {
			var data = storage[compName]
			if (data.hash[entID]) removeComponentNow(entID, compName)
		})
	}


	// remove given component from an entity
	function removeComponentNow(entID, compName) {
		var def = components[compName]
		var data = storage[compName]
		if (!data) return
		if (!data.hash[entID]) return // probably got removed twice during deferral

		// call onRemove handler - on each instance for multi components
		if (def.onRemove) {
			if (def.multi) {
				data.hash[entID].forEach(state => {
					def.onRemove(entID, state)
				})
			} else {
				def.onRemove(entID, data.hash[entID])
			}
		}

		// if multi, kill the states array to hopefully free the objects
		if (def.multi) data.hash[entID].length = 0

		// actual removal from data store
		DataStore.remove(data, entID)
	}



	// remove one state from a multi component
	function removeMultiCompNow(entID, compName, stateObj) {
		var def = components[compName]
		var data = storage[compName]
		var statesArr = data.hash[entID]
		if (!statesArr) return

		var i = statesArr.indexOf(stateObj)
		if (i < 0) return
		if (def.onRemove) {
			def.onRemove(entID, stateObj)
		}
		statesArr.splice(i, 1)

		// if this leaves the states list empty, remove the whole component
		if (statesArr.length === 0) {
			removeComponentNow(entID, compName)
		}
	}






	/*
	 * 
	 * 
	 *		internals for handling deferrals
	 * 
	 * 
	*/



	// debouncer - called whenever a deferral is queued
	function makeDeferralTimeout() {
		if (deferralTimeoutPending) return
		deferralTimeoutPending = true
		setTimeout(function () {
			deferralTimeoutPending = false
			runAllDeferredRemovals()
		}, 1)
	}
	var deferralTimeoutPending = false


	// Ping all removal queues. 
	// called before and after tick/render, and after deferrals are queued
	function runAllDeferredRemovals() {
		doDeferredComponentRemovals()
		doDeferredMultiComponentRemovals()
		doDeferredEntityRemovals()
	}


	// entities - queue of entity IDs
	function doDeferredEntityRemovals() {
		while (deferredEntityRemovals.length) {
			var entID = deferredEntityRemovals.pop()
			deleteEntityNow(entID)
		}
	}


	// components - queue of { id, compName }
	function doDeferredComponentRemovals() {
		while (deferredCompRemovals.length) {
			var obj = deferredCompRemovals.pop()
			removeComponentNow(obj.id, obj.compName)
		}
	}


	// multi components - queue of { id, compName, state }
	function doDeferredMultiComponentRemovals(ecs) {
		while (deferredMultiCompRemovals.length) {
			var obj = deferredMultiCompRemovals.pop()
			removeMultiCompNow(obj.id, obj.compName, obj.state)
			obj.state = null
		}
	}



}

